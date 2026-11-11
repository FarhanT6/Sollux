import { db } from '../config/db';
import { learnedCycleDays } from '../lib/billCadence';
import { fetchWait } from '../lib/fetchPlan';

const DAY = 86400000;

/**
 * When an account's next statement should be out: its newest statement
 * date plus the gap its bills usually come apart by (learnedCycleDays).
 * The schedule fetches from that day on; null with no statement yet.
 */
export async function nextBillExpected(utilityAccountId: string, cadence: string | null, termMonths?: number | null): Promise<{ on: Date | null; cycleDays: number; learned: boolean; last: { statementDate: Date; createdAt: Date } | null }> {
  const rows = await db.statement.findMany({
    where: { utilityAccountId, isScheduled: false, isDownPayment: false },
    orderBy: { statementDate: 'desc' }, take: 8,
    select: { statementDate: true, createdAt: true },
  });
  const { days, learned } = learnedCycleDays(rows.map(r => r.statementDate), cadence, termMonths);
  const last = rows[0] ?? null;
  return { on: last ? new Date(last.statementDate.getTime() + days * DAY) : null, cycleDays: days, learned, last };
}

/** Runs since the newest statement came in (or the last 60 days, with none) that brought nothing. */
export async function missesSince(utilityAccountId: string, lastCreatedAt: Date | null): Promise<number> {
  return db.syncJob.count({
    where: { utilityAccountId, completedAt: { not: null, gt: lastCreatedAt ?? new Date(Date.now() - 60 * DAY) }, statementsFound: 0 },
  });
}

/** Why a scheduled fetch of this account should not run now (null: it should), and when it next may. */
export async function scheduledWait(a: { id: string; billingCadence: string | null; termMonths?: number | null; lastAgentRunAt: Date | null }, billPosted = false, now = new Date()) {
  const { on, last } = await nextBillExpected(a.id, a.billingCadence, a.termMonths);
  const misses = await missesSince(a.id, last?.createdAt ?? null);
  return fetchWait({ now, nextOn: on, lastStatementDate: last?.statementDate ?? null, lastRun: a.lastAgentRunAt, misses, billPosted });
}
