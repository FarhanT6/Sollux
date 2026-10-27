/**
 * The facts an operating-expense statement is built from (lib/opexStatement.ts),
 * for one property over a period, and estimates for what has no records:
 * an insurance premium for a property with no policy on file, and the
 * property tax where no bill is on file and no parcel lookup is possible.
 *
 * Estimates come from Claude with web search: typical premiums and tax
 * rates for the property's place, type, size and value. They are ranges,
 * not quotes — a quote needs an application with a carrier or agent — and
 * the page says so; the answer also names local agents and carriers to ask.
 */
import Anthropic from '@anthropic-ai/sdk';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { scheduledRent, leaseSelect, type DateRange } from '../lib/pnl';
import { annualPremiumOf } from './insuranceReview';
import { meteredCreate, PRIMARY_MODEL, jsonIn } from '../ai/models';
import { withAiContext } from '../ai/meter';
import type { OpexConfig, OpexFacts, Estimate } from '../lib/opexStatement';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : typeof d === 'number' ? d : d.toNumber());
const r2 = (n: number) => Math.round(n * 100) / 100;
const UTILITY = ['ELECTRIC', 'GAS', 'WATER', 'SEWER', 'TRASH', 'SOLAR', 'INTERNET', 'PHONE', 'HOA', 'OTHER'];
const NOT_OPERATING = ['INSURANCE', 'PROPERTY_TAX', 'MORTGAGE_DEBT_SERVICE', 'CAPITAL_IMPROVEMENT'];

export type Period = 'last12' | 'ytd' | 'lastYear';

/** The period as whole months: the last 12 (to the end of this month), this year so far, or last calendar year. */
export function rangeFor(period: Period, now = new Date()): DateRange & { label: string } {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (period === 'ytd') return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y, m + 1, 1)), label: `${y} to date` };
  if (period === 'lastYear') return { start: new Date(Date.UTC(y - 1, 0, 1)), end: new Date(Date.UTC(y, 0, 1)), label: String(y - 1) };
  return { start: new Date(Date.UTC(y, m - 11, 1)), end: new Date(Date.UTC(y, m + 1, 1)), label: 'Last 12 months' };
}
const monthsOf = (r: DateRange) => (r.end.getUTCFullYear() - r.start.getUTCFullYear()) * 12 + (r.end.getUTCMonth() - r.start.getUTCMonth());

export interface SavedSetup { config?: OpexConfig; estimates?: { insurance?: Estimate | null; tax?: Estimate | null }; savedAt?: string }

export async function opexFacts(propertyId: string, userId: string, range: DateRange): Promise<{ facts: OpexFacts; saved: SavedSetup; property: { id: string; name: string; state: string; county: string | null; apn: string | null } }> {
  const p = await db.property.findFirst({
    where: { id: propertyId, userId },
    select: { id: true, nickname: true, address: true, state: true, county: true, apn: true, opexSetupJson: true, units: { select: { sqft: true } } },
  });
  if (!p) throw Object.assign(new Error('Property not found'), { status: 404 });
  const inRange = (field: 'dueDate' | 'statementDate') => ({ [field]: { gte: range.start, lt: range.end } });
  const [leases, accounts, expenses, policies, taxes, loans] = await Promise.all([
    db.lease.findMany({ where: { unit: { propertyId }, OR: [{ startDate: null }, { startDate: { lt: range.end } }], AND: { OR: [{ status: 'ACTIVE' }, { endDate: null }, { endDate: { gt: range.start } }] } }, select: leaseSelect }),
    db.utilityAccount.findMany({
      where: { propertyId },
      select: {
        id: true, providerName: true, accountNumber: true, category: true, escrowLoanId: true, isActive: true,
        statements: {
          where: { isScheduled: false, amountDue: { not: null }, OR: [inRange('dueDate'), { dueDate: null, ...inRange('statementDate') }] },
          select: { amountDue: true, penaltiesFees: true },
        },
      },
    }),
    db.expense.findMany({ where: { propertyId, isPersonal: false, date: { gte: range.start, lt: range.end } }, select: { category: true, amount: true, isCapEx: true } }),
    db.insurancePolicy.findMany({ where: { propertyId, isPersonal: false, isActive: true } }),
    db.taxAssessment.findMany({ where: { propertyId }, orderBy: { taxYear: 'desc' }, take: 2, select: { taxYear: true, annualTaxAmount: true, escrowLoanId: true } }),
    db.loan.findMany({ where: { propertyId, isPersonal: false, isActive: true }, select: { lender: true, monthlyPayment: true, loanPayments: { where: { date: { gte: range.start, lt: range.end } }, select: { amount: true, escrow: true } } } }),
  ]);
  const months = monthsOf(range);
  // Provider, kind and the account's last four: two Republic accounts on one property stay apart.
  const label = (a: { providerName: string; accountNumber: string | null; category: string }) => {
    const last4 = String(a.accountNumber ?? '').replace(/\D/g, '').slice(-4);
    return `${a.providerName} (${a.category.charAt(0) + a.category.slice(1).toLowerCase()}${last4 ? ` ··${last4}` : ''})`;
  };
  const sum = (xs: { amountDue: Prisma.Decimal | null }[]) => xs.reduce((t, s) => t + num(s.amountDue), 0);

  const utilities = accounts.filter(a => UTILITY.includes(a.category) && !a.escrowLoanId).map(a => ({
    id: a.id, name: label(a), category: a.category, total: r2(sum(a.statements)), fees: r2(a.statements.reduce((t, s) => t + num(s.penaltiesFees), 0)), bills: a.statements.length,
  })).filter(u => u.bills > 0 || accounts.find(a => a.id === u.id)?.isActive);

  const byCat = new Map<string, { total: number; count: number }>();
  let capex = 0;
  for (const e of expenses) {
    if (e.isCapEx || e.category === 'CAPITAL_IMPROVEMENT') { capex += num(e.amount); continue; }
    if (NOT_OPERATING.includes(e.category)) continue;
    const g = byCat.get(e.category) ?? { total: 0, count: 0 };
    g.total += num(e.amount); g.count++;
    byCat.set(e.category, g);
  }

  // Taxes: the newest bill on file, else tax accounts' bills, else logged tax payments.
  const loggedTax = expenses.filter(e => e.category === 'PROPERTY_TAX').reduce((t, e) => t + num(e.amount), 0);
  const taxBills = accounts.filter(a => a.category === 'TAXES').flatMap(a => a.statements);
  const tax = taxes[0]
    ? { annual: r2(num(taxes[0].annualTaxAmount)), source: `${taxes[0].taxYear} tax bill${taxes[0].escrowLoanId ? ' (paid from escrow)' : ''}` }
    : taxBills.length ? { annual: r2(sum(taxBills) * 12 / months), source: 'Tax account bills' }
    : loggedTax > 0 ? { annual: r2(loggedTax * 12 / months), source: 'Tax payments logged' }
    : { annual: null, source: null };

  // Insurance: active policies' premiums, else insurance accounts' bills, else logged premiums.
  const premiums = policies.map(annualPremiumOf).filter((x): x is number => x != null);
  const insBills = accounts.filter(a => a.category === 'INSURANCE').flatMap(a => a.statements);
  const loggedIns = expenses.filter(e => e.category === 'INSURANCE').reduce((t, e) => t + num(e.amount), 0);
  const insurance = premiums.length ? { annual: r2(premiums.reduce((t, x) => t + x, 0)), source: `${premiums.length} polic${premiums.length === 1 ? 'y' : 'ies'} on file` }
    : insBills.length ? { annual: r2(sum(insBills) * 12 / months), source: 'Insurance bills' }
    : loggedIns > 0 ? { annual: r2(loggedIns * 12 / months), source: 'Premiums logged' }
    : { annual: null, source: null };

  const paid = loans.flatMap(l => l.loanPayments);
  const monthlyPI = loans.reduce((t, l) => t + num(l.monthlyPayment), 0) || null;
  const loanBills = accounts.filter(a => a.category === 'LOAN').flatMap(a => a.statements);
  const sqft = p.units.reduce((t, u) => t + (u.sqft ?? 0), 0) || null;
  const saved = (p.opexSetupJson ?? {}) as SavedSetup;
  return {
    property: { id: p.id, name: p.nickname || p.address, state: p.state, county: p.county, apn: p.apn },
    saved,
    facts: {
      months, rentIncome: r2(scheduledRent(leases, range)), units: p.units.length, sqft,
      utilities, categories: [...byCat].map(([category, g]) => ({ category, total: r2(g.total), count: g.count })),
      capex: r2(capex), tax, insurance,
      debt: { paid: r2(paid.reduce((t, x) => t + num(x.amount), 0)), escrow: r2(paid.reduce((t, x) => t + num(x.escrow), 0)), monthlyPI, lenders: loans.map(l => l.lender), fromBills: r2(sum(loanBills)) },
      estimates: saved.estimates ?? {},
    },
  };
}

export async function saveSetup(propertyId: string, userId: string, patch: SavedSetup): Promise<SavedSetup> {
  const p = await db.property.findFirst({ where: { id: propertyId, userId }, select: { opexSetupJson: true } });
  if (!p) throw Object.assign(new Error('Property not found'), { status: 404 });
  const cur = (p.opexSetupJson ?? {}) as SavedSetup;
  const next: SavedSetup = {
    ...cur, ...patch,
    estimates: { ...(cur.estimates ?? {}), ...(patch.estimates ?? {}) },
    savedAt: new Date().toISOString(),
  };
  await db.property.update({ where: { id: propertyId }, data: { opexSetupJson: next as unknown as Prisma.InputJsonValue } });
  return next;
}

/**
 * An estimate for a property's yearly insurance premium or property tax,
 * from what is published for its place (web search). Saved on the setup.
 */
export async function estimateFor(propertyId: string, userId: string, kind: 'insurance' | 'tax'): Promise<Estimate> {
  const p = await db.property.findFirst({
    where: { id: propertyId, userId },
    select: {
      address: true, city: true, state: true, zip: true, county: true, type: true, estimatedValue: true, landValue: true, acquisitionPrice: true, acquisitionDate: true, lotSqft: true,
      units: { select: { bedrooms: true, bathrooms: true, sqft: true } },
      taxAssessments: { orderBy: { taxYear: 'desc' }, take: 1, select: { assessedValue: true, improvementValue: true, landValue: true } },
    },
  });
  if (!p) throw Object.assign(new Error('Property not found'), { status: 404 });
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('AI is not configured.'), { status: 503 });
  const t = p.taxAssessments[0];
  const facts = [
    `Location: ${p.city}, ${p.state} ${p.zip}${p.county ? ` (${p.county} County)` : ''} — street address withheld; the ZIP code is enough.`,
    `Type: ${p.type.replace(/_/g, ' ').toLowerCase()}; ${p.units.length || 1} unit${p.units.length === 1 ? '' : 's'}`,
    p.units.length ? `Units: ${p.units.map(u => [u.bedrooms != null && `${u.bedrooms} bd`, u.bathrooms != null && `${u.bathrooms} ba`, u.sqft && `${u.sqft} sqft`].filter(Boolean).join(' ')).join('; ')}` : null,
    p.lotSqft ? `Lot: ${p.lotSqft} sqft` : null,
    p.estimatedValue != null ? `Estimated value: $${num(p.estimatedValue).toLocaleString('en-US')}` : null,
    p.acquisitionPrice != null ? `Bought for $${num(p.acquisitionPrice).toLocaleString('en-US')}${p.acquisitionDate ? ` in ${p.acquisitionDate.getUTCFullYear()}` : ''}` : null,
    t?.assessedValue != null ? `Assessed (net taxable) value: $${num(t.assessedValue).toLocaleString('en-US')}` : null,
    t?.improvementValue != null ? `Improvements value on the tax roll: $${num(t.improvementValue).toLocaleString('en-US')}` : null,
  ].filter(Boolean).join('\n');
  const ask = kind === 'insurance'
    ? `Estimate the yearly premium for a landlord / dwelling-fire policy (or a commercial property policy, if commercial) on this property, with replacement-cost cover on the building, about $300,000–$1,000,000 liability where typical, and a common deductible. Search for current average premiums for this state, ZIP / county and property type, adjusted for the building's size and value, and local risks (wildfire, wind, hail, flood zone — flood is a separate policy and not included). Also name 3–5 carriers or local independent agents who write this kind of policy there, so the owner can ask for real quotes.`
    : `Estimate the yearly property tax on this property. Search for the effective tax rate in this county / city (and any typical special assessments or Mello-Roos in that area), and apply it to the assessed value if given, else to the estimated value or purchase price as the state's rules would (in California, about 1% of the purchase price plus local voter-approved levies and direct charges).`;
  const system = 'You estimate a property cost for its owner from published figures. Be realistic, not optimistic. Answer with JSON only, no other text.';
  const prompt = `${ask}

Property:
${facts}

Return ONLY JSON: {"low": number, "high": number, "typical": number, "basis": "two or three sentences: the figures you found and how you got from them to this property", "sources": [{"title": string, "url": string}]${kind === 'insurance' ? ', "contacts": ["carrier or agent name — phone or website", ...]' : ''}}. Yearly dollars.`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
  let text = '';
  await withAiContext({ userId }, async () => {
    // A server tool can pause a long turn; it is continued, at most a few times.
    for (let i = 0; i < 4; i++) {
      const res = await meteredCreate(client, 'opex-estimate', {
        model: PRIMARY_MODEL, max_tokens: 2500, system, messages,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 } as Anthropic.WebSearchTool20260209],
      });
      text = res.content.map(c => (c.type === 'text' ? c.text : '')).join('').trim() || text;
      if (res.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: res.content });
    }
  });
  const j = jsonIn(text);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  if (!j || n(j.typical) == null) throw Object.assign(new Error('The estimate did not come back in a usable form; try again.'), { status: 502 });
  const typical = n(j.typical)!;
  const est: Estimate = {
    low: n(j.low) ?? Math.round(typical * 0.8), high: n(j.high) ?? Math.round(typical * 1.25), typical,
    basis: String(j.basis ?? '').slice(0, 1200),
    sources: Array.isArray(j.sources) ? j.sources.filter((s: any) => s && /^https?:\/\//.test(String(s.url))).slice(0, 6).map((s: any) => ({ title: String(s.title ?? s.url).slice(0, 200), url: String(s.url).slice(0, 500) })) : [],
    contacts: Array.isArray(j.contacts) ? j.contacts.map((c: unknown) => String(c).slice(0, 200)).slice(0, 6) : undefined,
    at: new Date().toISOString(),
  };
  await saveSetup(propertyId, userId, { estimates: { [kind === 'tax' ? 'tax' : 'insurance']: est } });
  return est;
}
