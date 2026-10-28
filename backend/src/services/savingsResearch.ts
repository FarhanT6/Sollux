/**
 * Looking into each company the owner pays: what it offers that would cost
 * less — promotions and retention offers (internet, phone), a one-time
 * courtesy waiver of a late fee, a smaller or fewer carts (trash, recycling,
 * organics, where the rules allow), rate plans and programs (electric, gas,
 * water leak adjustments), autopay and paperless discounts — each with a
 * source and what it would be worth a year on what the owner spends there.
 *
 * One web-searching call per company (provider and category), its answer
 * kept for the month (memoAnswer) so a repeat run costs nothing. Runs in the
 * background, one company at a time; the progress and results are kept in
 * app_settings `savings-research:<userId>`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';
import { memoAnswer, checkBudget, withAiContext } from '../ai/meter';
import { paramsFor, PRIMARY_MODEL, jsonIn, meteredCreate } from '../ai/models';
import { estimateFor, type SavedSetup } from './operatingExpenses';
import { annualPremiumOf } from './insuranceReview';

export interface Tactic {
  title: string; how: string; perYear: number | null;
  effort: 'call' | 'online' | 'form' | 'switch'; confidence: 'high' | 'medium' | 'low'; source: string | null;
}
export interface CompanyResearch {
  provider: string; category: string; state: string; accounts: number; properties: string[];
  monthly: number; lateFees12: number; tactics: Tactic[]; error?: string;
}
/** A property's insurance against what a typical policy there costs (the operating-expenses estimate). */
export interface InsuranceCheck {
  propertyId: string; propertyName: string; paying: number; carriers: string[];
  low: number; high: number; typical: number; basis: string; contacts: string[]; sources: { title: string; url: string }[];
  /** Paying well over typical: worth shopping. */
  high_: boolean; error?: string;
}
export interface ResearchState { at: string; running: boolean; done: number; total: number; current: string | null; results: CompanyResearch[]; insurance?: InsuranceCheck[] }

const key = (userId: string) => `savings-research:${userId}`;
const running = new Set<string>();
const n = (v: unknown) => (v == null ? 0 : Number(v));
const r2 = (x: number) => Math.round(x * 100) / 100;
// What is worth researching: the recurring bills. Loans and taxes have their own rules.
const CATEGORIES = ['ELECTRIC', 'GAS', 'WATER', 'SEWER', 'TRASH', 'SOLAR', 'INTERNET', 'PHONE', 'INSURANCE', 'HOA', 'OTHER'];

export async function researchState(userId: string): Promise<ResearchState | null> {
  const row = await db.appSetting.findUnique({ where: { key: key(userId) } }).catch(() => null);
  if (!row) return null;
  const s = JSON.parse(row.value) as ResearchState;
  // A run that died with the server is not still running.
  return { ...s, running: running.has(userId) };
}
async function save(userId: string, s: ResearchState) {
  const value = JSON.stringify(s);
  await db.appSetting.upsert({ where: { key: key(userId) }, create: { key: key(userId), value }, update: { value } });
}

/** The companies to look into: provider and category, with what is spent there. */
async function companies(userId: string) {
  const since = new Date(); since.setUTCMonth(since.getUTCMonth() - 6);
  const yearAgo = new Date(); yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
  const accounts = await db.utilityAccount.findMany({
    where: { isActive: true, category: { in: CATEGORIES as any }, property: { userId, status: { not: 'SOLD' } } },
    select: {
      id: true, providerName: true, category: true,
      property: { select: { nickname: true, address: true, city: true, state: true } },
      statements: { where: { statementDate: { gte: yearAgo } }, select: { statementDate: true, amountDue: true, trueUpDeferred: true, penaltiesFees: true, rawDataJson: true }, orderBy: { statementDate: 'desc' } },
    },
  });
  const groups = new Map<string, { provider: string; category: string; state: string; cities: Set<string>; properties: Set<string>; accounts: number; spent6: number; lateFees12: number; charges: { name: string; amount: number }[] }>();
  for (const a of accounts) {
    const k = `${a.providerName.toLowerCase()}|${a.category}|${a.property.state}`;
    const g = groups.get(k) ?? { provider: a.providerName, category: a.category, state: a.property.state, cities: new Set(), properties: new Set(), accounts: 0, spent6: 0, lateFees12: 0, charges: [] };
    g.accounts++; g.cities.add(a.property.city); g.properties.add(a.property.nickname || a.property.address);
    for (const s of a.statements) {
      if (s.statementDate >= since) g.spent6 += n(s.amountDue) - n(s.trueUpDeferred);
      g.lateFees12 += n(s.penaltiesFees);
    }
    // The newest bill's charge lines: what is actually being paid for (cart sizes, plan names, fees).
    const lines = (a.statements[0]?.rawDataJson as any)?.chargeBreakdown;
    if (Array.isArray(lines) && g.charges.length < 30) for (const c of lines.slice(0, 15)) if (c?.name) g.charges.push({ name: String(c.name).slice(0, 80), amount: n(c.amount) });
    groups.set(k, g);
  }
  return [...groups.values()].filter(g => g.spent6 > 0).sort((x, y) => y.spent6 - x.spent6);
}

const SYSTEM = `You find real ways for a residential and small-commercial landlord to pay a company less. Search the web for what this company offers now in this state: promotions and retention offers (what calling to cancel gets), price-lock or new-customer pricing, a one-time courtesy waiver of a late fee (and how to ask), autopay or paperless discounts, a smaller plan or fewer/smaller carts or bins, rate plans, leak or high-bill adjustments, rebates and programs. Only what applies to this company and what the figures show; say how to do it (who to call, what to ask for, which page). Be accurate about rules: in California, for example, organics and recycling service is required for most customers under SB 1383 — say when a waiver (de minimis, physical space, shared service) or a smaller cart is the lawful route, not cancelling. Never invent a promotion: each tactic either comes from a page you found (give its URL) or is a well-known practice of this company (say so, confidence medium). Estimate what each is worth a year from the monthly spend given, conservatively; null when it cannot be estimated.
Answer with ONLY a JSON object: {"tactics":[{"title":string,"how":string,"perYear":number|null,"effort":"call"|"online"|"form"|"switch","confidence":"high"|"medium"|"low","source":string|null}]} — at most 4 tactics, the most valuable first; an empty list when nothing real applies.`;

async function researchOne(client: Anthropic, userId: string, g: Awaited<ReturnType<typeof companies>>[number]): Promise<Tactic[]> {
  const monthly = r2(g.spent6 / 6);
  const facts = {
    company: g.provider, service: g.category, state: g.state, cities: [...g.cities], accounts: g.accounts,
    monthlySpendAllAccounts: monthly, lateFeesLast12Months: r2(g.lateFees12), newestBillCharges: g.charges,
    month: new Date().toISOString().slice(0, 7),
  };
  const answer = await memoAnswer(`savings-research:${userId}:${g.provider.toLowerCase()}|${g.category}|${g.state}`, facts, async () => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `Company and what this owner pays:\n${JSON.stringify(facts, null, 1)}` }];
    const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 } as Anthropic.WebSearchTool20260209];
    for (let step = 0; step < 4; step++) {
      const res = await meteredCreate(client, 'savings-research', { ...paramsFor(PRIMARY_MODEL, { maxTokens: 3000, system: SYSTEM, messages }), tools } as Anthropic.MessageCreateParamsNonStreaming);
      if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
      return res.content.map((c: Anthropic.ContentBlock) => (c.type === 'text' ? c.text : '')).join('').trim();
    }
    return '';
  });
  const parsed = jsonIn(answer);
  const list = Array.isArray(parsed?.tactics) ? parsed.tactics : [];
  return list.slice(0, 4).map((t: any): Tactic => ({
    title: String(t?.title ?? '').slice(0, 160), how: String(t?.how ?? '').slice(0, 800),
    perYear: Number.isFinite(Number(t?.perYear)) && t?.perYear != null ? Math.round(Number(t.perYear)) : null,
    effort: ['call', 'online', 'form', 'switch'].includes(t?.effort) ? t.effort : 'call',
    confidence: ['high', 'medium', 'low'].includes(t?.confidence) ? t.confidence : 'medium',
    source: typeof t?.source === 'string' && /^https?:\/\//.test(t.source) ? t.source : null,
  })).filter((t: Tactic) => t.title && t.how);
}

/** Each insured property: what is paid a year, by policy premium or, without a policy, the insurance bills of the last year. */
async function insuredProperties(userId: string) {
  const yearAgo = new Date(); yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
  const props = await db.property.findMany({
    where: { userId, status: { not: 'SOLD' } },
    select: {
      id: true, nickname: true, address: true, opexSetupJson: true,
      insurance: { where: { isActive: true, isPersonal: false }, select: { carrier: true, premiumAmount: true, premiumFrequency: true, termPremium: true, effectiveDate: true, expirationDate: true, utilityAccountId: true } },
      utilityAccounts: { where: { isActive: true, category: 'INSURANCE' }, select: { id: true, providerName: true, statements: { where: { statementDate: { gte: yearAgo } }, select: { amountDue: true } } } },
    },
  });
  return props.map(p => {
    const linked = new Set(p.insurance.map(x => x.utilityAccountId).filter(Boolean));
    const fromPolicies = p.insurance.reduce((t, x) => t + (annualPremiumOf(x) ?? 0), 0);
    const fromBills = p.utilityAccounts.filter(a => !linked.has(a.id)).reduce((t, a) => t + a.statements.reduce((u, st) => u + n(st.amountDue), 0), 0);
    return {
      id: p.id, name: p.nickname || p.address, paying: r2(fromPolicies + fromBills),
      carriers: [...new Set([...p.insurance.map(x => x.carrier), ...p.utilityAccounts.filter(a => !linked.has(a.id)).map(a => a.providerName)])],
      saved: ((p.opexSetupJson ?? {}) as SavedSetup).estimates?.insurance ?? null,
    };
  }).filter(p => p.paying > 0);
}

/** Starts the research in the background; false when one is already running. */
export async function startSavingsResearch(userId: string): Promise<boolean> {
  if (running.has(userId)) return false;
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('AI is not configured.'), { status: 503 });
  await withAiContext({ userId }, () => checkBudget('savings-research'));
  const [list, insured] = await Promise.all([companies(userId), insuredProperties(userId)]);
  running.add(userId);
  const state: ResearchState = { at: new Date().toISOString(), running: true, done: 0, total: list.length + insured.length, current: null, results: [], insurance: [] };
  await save(userId, state);
  void withAiContext({ userId }, async () => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    try {
      for (const g of list) {
        state.current = g.provider; await save(userId, state);
        const base = { provider: g.provider, category: g.category, state: g.state, accounts: g.accounts, properties: [...g.properties], monthly: r2(g.spent6 / 6), lateFees12: r2(g.lateFees12) };
        try { state.results.push({ ...base, tactics: await researchOne(client, userId, g) }); }
        catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          state.results.push({ ...base, tactics: [], error: msg });
          if (/budget|allowance/i.test(msg)) break;
        }
        state.done++;
        await save(userId, state);
      }
      // Insurance, property by property: what is paid against a typical policy there.
      // An estimate made in the last 90 days is used again.
      for (const p of insured) {
        state.current = `Insurance · ${p.name}`; await save(userId, state);
        try {
          const fresh = p.saved && Date.now() - new Date(p.saved.at).getTime() < 90 * 86400000;
          const est = fresh ? p.saved! : await estimateFor(p.id, userId, 'insurance');
          state.insurance!.push({
            propertyId: p.id, propertyName: p.name, paying: p.paying, carriers: p.carriers,
            low: est.low, high: est.high, typical: est.typical, basis: est.basis, contacts: est.contacts ?? [], sources: est.sources ?? [],
            high_: p.paying > Math.max(est.high, est.typical * 1.25),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          state.insurance!.push({ propertyId: p.id, propertyName: p.name, paying: p.paying, carriers: p.carriers, low: 0, high: 0, typical: 0, basis: '', contacts: [], sources: [], high_: false, error: msg });
          if (/budget|allowance/i.test(msg)) break;
        }
        state.done++;
        await save(userId, state);
      }
    } finally {
      running.delete(userId);
      state.running = false; state.current = null;
      await save(userId, state).catch(() => {});
    }
  });
  return true;
}
