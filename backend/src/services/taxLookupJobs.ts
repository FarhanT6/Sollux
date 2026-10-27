/**
 * Property-tax lookups as jobs: queued from the Taxes page (or the monthly
 * refresh) on the insights queue, run by the workers (a browser is needed),
 * with where each stands kept on the property (taxLookupJson) for the page.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { insightQueue } from '../workers/queues';
import { lookupPropertyTax } from './propertyTaxLookup';

type Status = { status: 'queued' | 'running' | 'done' | 'failed'; at: string; note?: string | null; progress?: string | null; years?: number; defaults?: number };

const setStatus = (propertyId: string, s: Status) =>
  db.property.update({ where: { id: propertyId }, data: { taxLookupJson: s as unknown as Prisma.InputJsonValue } }).catch(() => {});

export async function queueTaxLookup(propertyId: string): Promise<void> {
  await setStatus(propertyId, { status: 'queued', at: new Date().toISOString() });
  await insightQueue.add('tax-lookup', { propertyId }, { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } });
}

export async function runQueuedTaxLookup(propertyId: string): Promise<void> {
  const startedAt = new Date().toISOString();
  await setStatus(propertyId, { status: 'running', at: startedAt });
  let last = 0;
  const r = await lookupPropertyTax(propertyId, t => {
    // A live line for the page, at most every few seconds.
    if (Date.now() - last < 4000) return;
    last = Date.now();
    void setStatus(propertyId, { status: 'running', at: startedAt, progress: t.slice(0, 160) });
  }).catch(err => ({ ok: false, report: null, error: err instanceof Error ? err.message : String(err), steps: 0, costUsd: 0 }));
  const years = r.report?.years?.length ?? 0, defaults = r.report?.defaults?.length ?? 0;
  await setStatus(propertyId, r.ok
    ? { status: 'done', at: new Date().toISOString(), note: r.report?.notes ?? null, years, defaults }
    : { status: 'failed', at: new Date().toISOString(), note: r.error ?? 'The lookup did not finish.' });
  console.log(`[TaxLookup] ${propertyId}: ${r.ok ? `${years} year(s), ${defaults} unpaid` : r.error} · ${r.steps} steps · $${r.costUsd.toFixed(3)}`);
}

/**
 * Monthly: properties looked up successfully before are looked up again
 * after 30 days, so a payment posting, a new bill or a default shows
 * without anyone asking. A property never looked up is left for its owner
 * to start (each lookup spends their AI allowance).
 */
export async function refreshTaxLookups(): Promise<number> {
  const props = await db.property.findMany({ where: { apn: { not: null }, status: 'ACTIVE' }, select: { id: true, taxLookupJson: true } });
  const due = props.filter(p => {
    const s = p.taxLookupJson as Status | null;
    return s?.status === 'done' && Date.now() - new Date(s.at).getTime() > 30 * 24 * 3600_000;
  });
  for (const p of due) await queueTaxLookup(p.id);
  return due.length;
}
