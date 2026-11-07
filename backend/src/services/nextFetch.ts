import { db } from '../config/db';
import { learnedCycleDays } from '../lib/billCadence';

const DAY = 86400000;

/**
 * When an account's next statement should be out: its newest statement
 * date plus the gap its bills usually come apart by (learnedCycleDays).
 * The schedule fetches from that day on; null with no statement yet.
 */
export async function nextBillExpected(utilityAccountId: string, cadence: string | null): Promise<{ on: Date | null; cycleDays: number; learned: boolean; last: { statementDate: Date; createdAt: Date } | null }> {
  const rows = await db.statement.findMany({
    where: { utilityAccountId, isScheduled: false, isDownPayment: false },
    orderBy: { statementDate: 'desc' }, take: 8,
    select: { statementDate: true, createdAt: true },
  });
  const { days, learned } = learnedCycleDays(rows.map(r => r.statementDate), cadence);
  const last = rows[0] ?? null;
  return { on: last ? new Date(last.statementDate.getTime() + days * DAY) : null, cycleDays: days, learned, last };
}
