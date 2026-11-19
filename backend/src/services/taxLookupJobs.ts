/**
 * Property-tax lookups as jobs: queued from the Taxes page (or the monthly
 * refresh) on the insights queue, run by the workers (a browser is needed),
 * with where each stands kept on the property (taxLookupJson) for the page.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { insightQueue } from '../workers/queues';
import { lookupPropertyTax, type LookupRun } from './propertyTaxLookup';
import { withAiContext, checkBudget } from '../ai/meter';
import { connectorFor } from './connector';

type Status = { status: 'queued' | 'running' | 'done' | 'failed' | 'choose' | 'cancelled' | 'waiting'; at: string; note?: string | null; progress?: string | null; years?: number; defaults?: number;
  /** Years the lookup added that were not on file before (the rest were updated). */
  added?: number;
  /** What the lookup spent on AI. */
  costUsd?: number;
  /** waiting: the property whose lookup has to work first. */
  firstId?: string;
  /** Parcels that could be this property, for the owner to pick from. */
  candidates?: { apn: string; situsAddress: string | null; owner: string | null; note: string | null }[] };

const setStatus = (propertyId: string, s: Status) =>
  db.property.update({ where: { id: propertyId }, data: { taxLookupJson: s as unknown as Prisma.InputJsonValue } }).catch(() => {});

export async function queueTaxLookup(propertyId: string): Promise<void> {
  await setStatus(propertyId, { status: 'queued', at: new Date().toISOString() });
  await insightQueue.add('tax-lookup', { propertyId }, { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } });
}

// One lookup at a time in a worker: several at once fought over one browser
// profile ("ProcessSingleton") and over the owner's Chrome tabs.
let chain: Promise<unknown> = Promise.resolve();

export function runQueuedTaxLookup(propertyId: string): Promise<void> {
  const next = chain.then(() => runOne(propertyId), () => runOne(propertyId));
  chain = next.catch(() => {});
  return next;
}

const statusOf = async (propertyId: string) =>
  ((await db.property.findUnique({ where: { id: propertyId }, select: { taxLookupJson: true } }))?.taxLookupJson ?? null) as Status | null;

/** Stop a property's lookup: a queued or waiting one is skipped, a running one stops at its next step. */
export async function cancelTaxLookup(propertyId: string): Promise<boolean> {
  const s = await statusOf(propertyId);
  if (s?.status !== 'queued' && s?.status !== 'running' && s?.status !== 'waiting') return false;
  await setStatus(propertyId, { status: 'cancelled', at: new Date().toISOString() });
  return true;
}

/**
 * Look up several properties, one first: the rest wait ('waiting') and start
 * only when that one works, so a lookup that fails for a reason all of them
 * share (the computer asleep, a site change) costs one lookup, not all of them.
 * The first is the one most likely to work: a parcel number on file (no
 * search for it), in a county whose tax site Sollux knows.
 */
export async function queueLookupBatch(propertyIds: string[]): Promise<{ first: string | null; waiting: number }> {
  if (!propertyIds.length) return { first: null, waiting: 0 };
  const props = await db.property.findMany({ where: { id: { in: propertyIds } }, select: { id: true, apn: true, state: true, county: true } });
  const { startUrlFor } = await import('../lib/taxLookupReport');
  const score = (p: (typeof props)[number]) => (p.apn ? 2 : 0) + (p.state && !startUrlFor(p.state, p.county, '').includes('duckduckgo') ? 1 : 0);
  const first = [...props].sort((a, b) => score(b) - score(a))[0];
  const at = new Date().toISOString();
  for (const p of props) if (p.id !== first.id) await setStatus(p.id, { status: 'waiting', at, firstId: first.id });
  await queueTaxLookup(first.id);
  return { first: first.id, waiting: props.length - 1 };
}

/** The first of a batch finished: the others start if it worked, and are told why not if it did not. */
export async function releaseWaiting(firstId: string, worked: boolean, why: string | null): Promise<void> {
  const first = await db.property.findUnique({ where: { id: firstId }, select: { userId: true, nickname: true, address: true } });
  if (!first) return;
  const rows = await db.property.findMany({ where: { userId: first.userId }, select: { id: true, taxLookupJson: true } });
  const waiting = rows.filter(r => { const s = r.taxLookupJson as Status | null; return s?.status === 'waiting' && s.firstId === firstId; });
  for (const r of waiting) {
    if (worked) await queueTaxLookup(r.id);
    else await setStatus(r.id, { status: 'cancelled', at: new Date().toISOString(), note: `Not started: the first lookup (${first.nickname || first.address}) did not work${why ? ` — ${why.slice(0, 200)}` : ''}. Nothing was spent on this one.` });
  }
}

async function runOne(propertyId: string): Promise<void> {
  // Cancelled while it waited in line.
  if ((await statusOf(propertyId))?.status === 'cancelled') return;
  const startedAt = new Date().toISOString();
  await setStatus(propertyId, { status: 'running', at: startedAt });
  let last = 0;
  const r = await lookupPropertyTax(propertyId, t => {
    // A live line for the page, at most every few seconds.
    if (Date.now() - last < 4000) return;
    last = Date.now();
    void statusOf(propertyId).then(s => s?.status === 'cancelled' ? undefined : setStatus(propertyId, { status: 'running', at: startedAt, progress: t.slice(0, 160) }));
  }, async () => (await statusOf(propertyId))?.status === 'cancelled').catch((err): LookupRun => ({ ok: false, report: null, error: err instanceof Error ? err.message : String(err), steps: 0, costUsd: 0 }));
  // What was saved, not what the page listed: a year with no amount is not kept.
  const years = r.saved?.years ?? 0, defaults = r.saved?.defaults ?? 0;
  const costUsd = Math.round(r.costUsd * 100) / 100;
  if ((await statusOf(propertyId))?.status === 'cancelled') {
    console.log(`[TaxLookup] ${propertyId}: cancelled · ${r.steps} steps · $${r.costUsd.toFixed(3)}`);
    await releaseWaiting(propertyId, false, 'it was cancelled');
    return;
  }
  await setStatus(propertyId, r.ok
    ? { status: 'done', at: new Date().toISOString(), note: r.report?.notes ?? null, years, defaults, added: r.saved?.added ?? 0, costUsd }
    : r.candidates?.length
      ? { status: 'choose', at: new Date().toISOString(), note: r.error ?? null, candidates: r.candidates, costUsd }
      : { status: 'failed', at: new Date().toISOString(), note: r.error ?? 'The lookup did not finish.', costUsd });
  // Several possible parcels is the search working; the owner picks one, and the others go ahead.
  await releaseWaiting(propertyId, r.ok || !!r.candidates?.length, r.error ?? null);
  console.log(`[TaxLookup] ${propertyId}: ${r.ok ? `${years} year(s), ${defaults} unpaid` : r.error} · ${r.steps} steps · $${r.costUsd.toFixed(3)}`);
}

/**
 * Monthly: properties looked up successfully before are looked up again
 * after 30 days, so a payment posting, a new bill or a default shows
 * without anyone asking. A property never looked up is left for its owner
 * to start (each lookup spends their AI allowance).
 *
 * Only while the owner's connector is online: county tax sites turn Sollux's
 * own browser away, and a refresh run there (the computer asleep) failed and
 * was never tried again. Checked every hour, so it runs when the computer is on.
 */
export async function refreshTaxLookups(): Promise<number> {
  const props = await db.property.findMany({ where: { apn: { not: null }, status: 'ACTIVE' }, select: { id: true, userId: true, taxLookupJson: true } });
  const online = new Map<string, boolean>();
  const connected = async (userId: string) => {
    if (!online.has(userId)) online.set(userId, !!(await connectorFor(userId).catch(() => null)));
    return online.get(userId)!;
  };
  const due: { id: string; taxLookupJson: unknown }[] = [];
  for (const p of props) {
    const s = p.taxLookupJson as Status | null;
    if (s?.status === 'done' && Date.now() - new Date(s.at).getTime() > 30 * 24 * 3600_000 && await connected(p.userId)) due.push(p);
  }
  // Lookups the AI budget stopped before they began are run once it allows:
  // the owner asked for them, so nobody has to press the button again.
  const stopped = await db.property.findMany({ where: { status: 'ACTIVE' }, select: { id: true, userId: true, taxLookupJson: true } });
  for (const p of stopped) {
    const s = p.taxLookupJson as Status | null;
    if (s?.status !== 'failed' || !/AI budget|allowance/i.test(s.note ?? '') || due.some(d => d.id === p.id)) continue;
    const ok = await withAiContext({ userId: p.userId }, () => checkBudget('tax-lookup')).then(() => true, () => false);
    if (ok) due.push({ id: p.id, taxLookupJson: p.taxLookupJson });
  }
  for (const p of due) await queueTaxLookup(p.id);
  return due.length;
}
