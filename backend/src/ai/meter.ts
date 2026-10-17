/**
 * What Claude costs Sollux, call by call. Every request goes through here
 * (models.ts): it is refused once the month's spend reaches the budget, and
 * afterwards its tokens and their price are written to ai_usage under the
 * feature that asked, so the spend page can say where the money went.
 *
 *   AI_MONTHLY_BUDGET       dollars per calendar month for the whole app
 *                           (default 25; "none" turns the cap off)
 *   AI_USER_MONTHLY_BUDGET  dollars per account per month (default: no cap)
 *
 * When the cap is reached every feature falls back to what it does without
 * Claude (plain-text bill reading, template messages), and nothing is lost.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';

/** Dollars per million tokens: [input, output]. Cache writes cost 1.25× input, reads 0.1×. */
const PRICES: [RegExp, number, number][] = [
  [/haiku-5/, 0.1, 0.5],
  [/haiku-4/, 1, 5],
  [/sonnet-5/, 2, 10],
  [/sonnet/, 3, 15],
  [/opus-5-5/, 4, 20],
  [/opus/, 5, 25],
  [/fable|mythos/, 10, 50],
];
const priceOf = (model: string): [number, number] => {
  const p = PRICES.find(([re]) => re.test(model));
  return p ? [p[1], p[2]] : [5, 25]; // unknown: priced like Opus, so the cap errs on the safe side
};

export function costOf(model: string, u: Pick<Anthropic.Usage, 'input_tokens' | 'output_tokens'> & { cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const [inp, out] = priceOf(model);
  return (u.input_tokens * inp + (u.cache_creation_input_tokens ?? 0) * inp * 1.25 + (u.cache_read_input_tokens ?? 0) * inp * 0.1 + u.output_tokens * out) / 1_000_000;
}

/** Who a call is for, carried through async work without threading it through every function. */
export interface AiContext { userId?: string | null; test?: boolean }
const store = new AsyncLocalStorage<AiContext>();
export const withAiContext = <T>(ctx: AiContext, fn: () => Promise<T>): Promise<T> => store.run({ ...store.getStore(), ...ctx }, fn);
const ctx = () => store.getStore() ?? {};

export class AiBudgetError extends Error {
  constructor(message: string) { super(message); this.name = 'AiBudgetError'; }
}

const budget = (name: string, dflt: number | null): number | null => {
  const v = process.env[name]?.trim();
  if (!v) return dflt;
  if (v.toLowerCase() === 'none') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
export const monthlyBudget = () => budget('AI_MONTHLY_BUDGET', 25);
const userBudget = () => budget('AI_USER_MONTHLY_BUDGET', null);

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };

// The month's spend, read from the database at most once a minute and kept
// current in between by adding each call as it is recorded.
let spent: { at: number; month: number; total: number; byUser: Map<string, number> } | null = null;
async function spend(): Promise<NonNullable<typeof spent>> {
  const month = monthStart().getTime();
  if (spent && spent.month === month && Date.now() - spent.at < 60_000) return spent;
  const rows = await db.aiUsage.groupBy({ by: ['userId'], where: { createdAt: { gte: monthStart() } }, _sum: { costUsd: true } });
  const byUser = new Map<string, number>();
  let total = 0;
  for (const r of rows) { const c = Number(r._sum.costUsd ?? 0); total += c; if (r.userId) byUser.set(r.userId, c); }
  spent = { at: Date.now(), month, total, byUser };
  return spent;
}

export async function monthSpend(): Promise<number> { return (await spend()).total; }

/** Throws AiBudgetError when this month's budget (the app's, or this account's) is used up. */
export async function checkBudget(feature: string): Promise<void> {
  const cap = monthlyBudget(), perUser = userBudget();
  if (cap == null && perUser == null) return;
  const s = await spend();
  if (cap != null && s.total >= cap) {
    throw new AiBudgetError(`AI budget for the month reached ($${s.total.toFixed(2)} of $${cap}) — ${feature} skipped. Raise AI_MONTHLY_BUDGET on Render to continue.`);
  }
  const uid = ctx().userId;
  if (perUser != null && uid && (s.byUser.get(uid) ?? 0) >= perUser) {
    throw new AiBudgetError(`This account's AI allowance for the month is used up — ${feature} skipped.`);
  }
}

/** Write one call's tokens and cost. Never throws: a failed write must not fail the feature. */
export async function recordUsage(feature: string, model: string, usage: Anthropic.Usage, fellBack = false): Promise<number> {
  const cost = costOf(model, usage);
  const { userId = null, test = false } = ctx();
  if (spent) { spent.total += cost; if (userId) spent.byUser.set(userId, (spent.byUser.get(userId) ?? 0) + cost); }
  await db.aiUsage.create({
    data: {
      feature, model, userId, test, fellBack,
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0, cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      costUsd: cost.toFixed(6),
    },
  }).catch(err => console.warn('[AI spend] could not record:', err instanceof Error ? err.message : err));
  return cost;
}

/**
 * The previous answer for this key when the facts behind it are the same;
 * otherwise ask, and keep the answer. A nightly job that finds the same leak
 * or the same list of overdue bills does not pay to have it re-worded.
 */
export async function memoAnswer(key: string, facts: unknown, ask: () => Promise<string>): Promise<string> {
  const inputHash = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  const prev = await db.aiMemo.findUnique({ where: { key } }).catch(() => null);
  if (prev && prev.inputHash === inputHash) return prev.answer;
  const answer = await ask();
  if (answer) await db.aiMemo.upsert({ where: { key }, create: { key, inputHash, answer }, update: { inputHash, answer } }).catch(() => {});
  return answer;
}
