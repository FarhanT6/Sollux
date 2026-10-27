/**
 * A review of the portfolio's insurance, property by property: what is
 * covered (property, liability, flood, umbrella), what each costs a year,
 * whether the dwelling limit keeps up with what the building would cost to
 * replace, and what is missing or about to lapse — no property policy, a
 * rental with no liability, a mortgage with no mortgagee on the policy,
 * actual-cash-value cover, a percentage wind deductible spelled out in
 * dollars, a renewal coming with its premium change.
 *
 * Replacement cost is not known exactly; the improvements value on the
 * newest tax roll (or estimated value less land) stands in for it, and the
 * check uses the usual 80% coinsurance line.
 */
import { db } from '../config/db';

export type Severity = 'ALERT' | 'WARNING' | 'INFO';
export interface ReviewFlag { code: string; severity: Severity; text: string; policyId?: string }
export interface PolicyLine {
  id: string; carrier: string; policyNumber: string | null; policyType: string; annualPremium: number | null;
  effectiveDate: string | null; expirationDate: string | null; dwellingLimit: number | null; liabilityLimit: number | null;
  deductible: number | null; windHailDeductible: string | null; windHailDollars: number | null; replacementCostBasis: string | null;
  mortgageePayee: string | null; agentName: string | null; agentPhone: string | null; agentEmail: string | null;
  priorPremium: number | null; premiumChange: number | null;
}
export interface PropertyReview {
  propertyId: string; name: string; state: string | null; type: string;
  policies: PolicyLine[];
  coverage: { property: boolean; liability: boolean; flood: boolean; umbrella: boolean };
  annualPremium: number;
  replacementProxy: number | null; replacementSource: string | null; dwellingLimit: number | null; coverageRatio: number | null;
  premiumPerThousand: number | null;
  openClaims: number;
  flags: ReviewFlag[];
}
export interface InsuranceReview {
  properties: PropertyReview[];
  totals: { annualPremium: number; policies: number; alerts: number; warnings: number; renewalsSoon: number };
  renewals: { propertyId: string; name: string; policyId: string; carrier: string; policyType: string; expirationDate: string; days: number; annualPremium: number | null; premiumChange: number | null }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const DAY = 86_400_000;
const RENTAL = new Set(['RENTAL', 'INVESTMENT', 'RESIDENTIAL_MULTI', 'COMMERCIAL', 'MIXED_USE', 'GOLF_COURSE']);
const MORTGAGES = ['MORTGAGE', 'HELOC', 'DSCR', 'COMMERCIAL', 'HARD_MONEY', 'SELLER_FINANCING'];
/** States where flood cover is worth asking about on every property. */
const FLOOD_STATES = new Set(['FL', 'LA', 'TX', 'SC', 'NC', 'MS', 'AL']);

/** A premium as a year's cost: the term total, else the installment times its frequency. */
export function annualPremiumOf(p: { premiumAmount: unknown; premiumFrequency: string; termPremium?: unknown; effectiveDate?: Date | null; expirationDate?: Date | null }): number | null {
  const term = p.termPremium != null ? Number(p.termPremium) : null;
  if (term != null && term > 0) {
    // A six-month term is half a year.
    const months = p.effectiveDate && p.expirationDate ? Math.round((p.expirationDate.getTime() - p.effectiveDate.getTime()) / (30.44 * DAY)) : 12;
    return r2(months > 0 && months < 12 ? term * (12 / months) : term);
  }
  const amt = Number(p.premiumAmount);
  if (!(amt > 0)) return null;
  return r2(p.premiumFrequency === 'MONTHLY' ? amt * 12 : p.premiumFrequency === 'SEMI_ANNUAL' ? amt * 2 : amt);
}

/** "2% of Coverage A", "1%", "$2,500" → dollars against the dwelling limit. */
export function windDollars(text: string | null | undefined, dwelling: number | null): number | null {
  if (!text) return null;
  const pct = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct && dwelling) return r2((Number(pct[1]) / 100) * dwelling);
  const usd = text.match(/\$?\s*([\d,]+(?:\.\d{2})?)/);
  return usd && !pct ? Number(usd[1].replace(/,/g, '')) : null;
}

export async function reviewInsurance(userId: string, now = new Date()): Promise<InsuranceReview> {
  const props = await db.property.findMany({
    where: { userId, status: { not: 'SOLD' } },
    select: {
      id: true, nickname: true, address: true, state: true, type: true, estimatedValue: true, landValue: true,
      insurance: { where: { isPersonal: false }, orderBy: { expirationDate: 'desc' } },
      taxAssessments: { select: { taxYear: true, improvementValue: true }, orderBy: { taxYear: 'desc' }, take: 3 },
      loans: { where: { isActive: true }, select: { loanType: true, lender: true } },
      insuranceClaims: { where: { status: { in: ['OPEN', 'IN_REVIEW', 'APPROVED'] } }, select: { id: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const out: PropertyReview[] = [];
  const renewals: InsuranceReview['renewals'] = [];
  const today = now.getTime();
  for (const p of props) {
    const name = p.nickname || p.address;
    const all = p.insurance;
    const active = all.filter(x => x.isActive && (!x.expirationDate || x.expirationDate.getTime() >= today - 30 * DAY));
    const flags: ReviewFlag[] = [];
    const lines: PolicyLine[] = active.map(x => {
      const annual = annualPremiumOf(x);
      // The term before: same carrier and kind, ended before this one began.
      const prior = all.find(o => o.id !== x.id && o.policyType === x.policyType && o.carrier === x.carrier && o.expirationDate && x.effectiveDate
        && o.expirationDate.getTime() <= x.effectiveDate.getTime() + 5 * DAY);
      const priorAnnual = prior ? annualPremiumOf(prior) : null;
      const dwelling = x.dwellingLimit != null ? Number(x.dwellingLimit) : null;
      return {
        id: x.id, carrier: x.carrier, policyNumber: x.policyNumber, policyType: x.policyType, annualPremium: annual,
        effectiveDate: iso(x.effectiveDate), expirationDate: iso(x.expirationDate), dwellingLimit: dwelling,
        liabilityLimit: x.liabilityLimit != null ? Number(x.liabilityLimit) : null, deductible: x.deductible != null ? Number(x.deductible) : null,
        windHailDeductible: x.windHailDeductible, windHailDollars: windDollars(x.windHailDeductible, dwelling), replacementCostBasis: x.replacementCostBasis,
        mortgageePayee: x.mortgageePayee, agentName: x.agentName, agentPhone: x.agentPhone, agentEmail: x.agentEmail,
        priorPremium: priorAnnual, premiumChange: annual != null && priorAnnual ? r2(annual - priorAnnual) : null,
      };
    });
    const ofType = (t: string) => lines.filter(l => l.policyType === t);
    const propertyLines = lines.filter(l => ['PROPERTY', 'BUSINESS', 'OTHER'].includes(l.policyType) && (l.dwellingLimit != null || l.policyType === 'PROPERTY'));
    const coverage = {
      property: propertyLines.length > 0,
      liability: ofType('LIABILITY').length > 0 || ofType('UMBRELLA').length > 0 || lines.some(l => (l.liabilityLimit ?? 0) > 0),
      flood: ofType('FLOOD').length > 0,
      umbrella: ofType('UMBRELLA').length > 0,
    };
    const annualPremium = r2(lines.reduce((t, l) => t + (l.annualPremium ?? 0), 0));
    const tax = p.taxAssessments.find(t => t.improvementValue != null);
    const replacementProxy = tax ? Number(tax.improvementValue) : p.estimatedValue != null && p.landValue != null ? Number(p.estimatedValue) - Number(p.landValue) : null;
    const replacementSource = tax ? `improvements on the ${tax.taxYear} tax roll` : replacementProxy != null ? 'estimated value less land' : null;
    const dwellingLimit = propertyLines.reduce((t, l) => t + (l.dwellingLimit ?? 0), 0) || null;
    const coverageRatio = replacementProxy && dwellingLimit ? r2(dwellingLimit / replacementProxy) : null;
    const value = p.estimatedValue != null ? Number(p.estimatedValue) : null;

    if (p.type !== 'LAND' && !coverage.property) flags.push({ code: 'NO_PROPERTY', severity: 'ALERT', text: 'No active property policy on file.' });
    if (coverageRatio != null && coverageRatio < 0.8) flags.push({
      code: 'UNDERINSURED', severity: 'WARNING',
      text: `Dwelling cover ${fmt(dwellingLimit!)} is ${Math.round(coverageRatio * 100)}% of ${fmt(replacementProxy!)} (${replacementSource}). Below 80%, a coinsurance clause can cut what a partial loss pays — ask the agent for a replacement-cost estimate.`,
    });
    if (RENTAL.has(p.type) && !coverage.liability) flags.push({ code: 'NO_LIABILITY', severity: 'WARNING', text: 'A rental with no liability cover on file (landlord policy liability, or a separate liability / umbrella policy).' });
    if (FLOOD_STATES.has(String(p.state ?? '').toUpperCase()) && !coverage.flood && p.type !== 'LAND') flags.push({ code: 'NO_FLOOD', severity: 'INFO', text: 'No flood policy on file. Standard policies exclude flood; check the FEMA flood zone, and whether the lender requires it.' });
    const mortgage = p.loans.find(l => MORTGAGES.includes(l.loanType));
    if (mortgage && propertyLines.length && !propertyLines.some(l => l.mortgageePayee)) flags.push({ code: 'NO_MORTGAGEE', severity: 'INFO', text: `${mortgage.lender} holds a mortgage, but no property policy names a mortgagee. Lenders require it; a missing one can trigger force-placed insurance.` });
    for (const l of lines) {
      if (l.replacementCostBasis && /actual\s+cash/i.test(l.replacementCostBasis)) flags.push({ code: 'ACV', severity: 'INFO', policyId: l.id, text: `${l.carrier}: actual cash value — a loss is paid less depreciation. Replacement cost cover pays to rebuild.` });
      if (l.windHailDollars && l.deductible && l.windHailDollars > l.deductible * 2) flags.push({ code: 'WIND_DEDUCTIBLE', severity: 'INFO', policyId: l.id, text: `${l.carrier}: wind/hail deductible ${l.windHailDeductible} is ${fmt(l.windHailDollars)} on this dwelling limit, against ${fmt(l.deductible)} otherwise.` });
      if (l.expirationDate) {
        const days = Math.round((new Date(`${l.expirationDate}T12:00:00Z`).getTime() - today) / DAY);
        if (days < 0) flags.push({ code: 'EXPIRED', severity: 'ALERT', policyId: l.id, text: `${l.carrier} ${l.policyNumber ?? ''} expired ${l.expirationDate} and no renewal is on file.`.replace(/\s+/g, ' ') });
        if (days <= 120 && days >= -30) renewals.push({ propertyId: p.id, name, policyId: l.id, carrier: l.carrier, policyType: l.policyType, expirationDate: l.expirationDate, days, annualPremium: l.annualPremium, premiumChange: l.premiumChange });
      }
      if (l.premiumChange != null && l.priorPremium && l.premiumChange / l.priorPremium >= 0.15) flags.push({ code: 'PREMIUM_JUMP', severity: 'INFO', policyId: l.id, text: `${l.carrier}: premium up ${Math.round((l.premiumChange / l.priorPremium) * 100)}% on the last term (${fmt(l.priorPremium)} → ${fmt(l.annualPremium!)}). Worth a quote elsewhere.` });
    }
    out.push({
      propertyId: p.id, name, state: p.state, type: p.type, policies: lines, coverage, annualPremium,
      replacementProxy, replacementSource, dwellingLimit, coverageRatio,
      premiumPerThousand: value ? r2((annualPremium / value) * 1000) : null,
      openClaims: p.insuranceClaims.length, flags,
    });
  }
  const flagsAll = out.flatMap(o => o.flags);
  return {
    properties: out,
    renewals: renewals.sort((a, b) => a.days - b.days),
    totals: {
      annualPremium: r2(out.reduce((t, o) => t + o.annualPremium, 0)), policies: out.reduce((t, o) => t + o.policies.length, 0),
      alerts: flagsAll.filter(f => f.severity === 'ALERT').length, warnings: flagsAll.filter(f => f.severity === 'WARNING').length,
      renewalsSoon: renewals.filter(r => r.days <= 60).length,
    },
  };
}

function fmt(n: number) { return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`; }
