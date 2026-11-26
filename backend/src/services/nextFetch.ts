import { db } from '../config/db';
import { learnedCycleDays } from '../lib/billCadence';
import { fetchWait, midnightAfter, nextStatementAfter } from '../lib/fetchPlan';

const DAY = 86400000;

/**
 * When an account's next statement should be out: for a monthly bill, the day
 * of the month its statements usually come out on; else its newest statement
 * date plus the gap its bills come apart by (learnedCycleDays). The schedule
 * looks for it at midnight after that day (fetchAt); null with no statement yet.
 */
export async function nextBillExpected(utilityAccountId: string, cadence: string | null, termMonths?: number | null): Promise<{ on: Date | null; fetchAt: Date | null; cycleDays: number; learned: boolean; last: { statementDate: Date; createdAt: Date } | null }> {
  const rows = await db.statement.findMany({
    where: { utilityAccountId, isScheduled: false, isDownPayment: false },
    orderBy: { statementDate: 'desc' }, take: 8,
    select: { statementDate: true, createdAt: true, pdfS3Key: true, rawDataJson: true },
  });
  const dates = rows.map(r => r.statementDate);
  const { days, learned } = learnedCycleDays(dates, cadence, termMonths);
  const last = rows[0] ? { statementDate: rows[0].statementDate, createdAt: rows[0].createdAt } : null;
  // The newest bill is the portal's page saved in place of its PDF (the PDF was not out yet), on an
  // account whose portal gives PDFs: the PDF is still due — fetched the next night, then backing
  // off — for ten days, after which the page stands.
  const pageSaved = (r: (typeof rows)[number]) => !!(r.rawDataJson as Record<string, unknown> | null)?.pageSaved;
  if (rows[0] && pageSaved(rows[0]) && (rows[0].rawDataJson as Record<string, unknown> | null)?.pdfToCome !== false && Date.now() - rows[0].statementDate.getTime() < 10 * DAY
    && rows.slice(1).some(r => r.pdfS3Key && !pageSaved(r) && (r.rawDataJson as Record<string, unknown> | null)?.source === 'portal')) {
    return { on: rows[0].statementDate, fetchAt: midnightAfter(rows[0].statementDate), cycleDays: days, learned, last };
  }
  const on = last ? nextStatementAfter(last.statementDate, dates, days) : null;
  return { on, fetchAt: on ? midnightAfter(on) : null, cycleDays: days, learned, last };
}

/**
 * Runs that brought nothing since `after` — the newest statement came in, and the next was due
 * (runs before it was due, such as another account's on the same login, could not have found it);
 * the last 60 days with no statement.
 */
export async function missesSince(utilityAccountId: string, after: Date | null): Promise<number> {
  return db.syncJob.count({
    where: { utilityAccountId, completedAt: { not: null, gt: after ?? new Date(Date.now() - 60 * DAY) }, statementsFound: 0 },
  });
}

/** Why a scheduled fetch of this account should not run now (null: it should), and when it next may. */
export async function scheduledWait(a: { id: string; billingCadence: string | null; termMonths?: number | null; lastAgentRunAt: Date | null }, billPosted = false, now = new Date()) {
  const { on, fetchAt, last } = await nextBillExpected(a.id, a.billingCadence, a.termMonths);
  const since = [last?.createdAt, fetchAt && !billPosted ? fetchAt : null].filter((d): d is Date => !!d).sort((x, y) => y.getTime() - x.getTime())[0] ?? null;
  const misses = await missesSince(a.id, since);
  return fetchWait({ now, nextOn: on, fetchAt, lastStatementDate: last?.statementDate ?? null, lastRun: a.lastAgentRunAt, misses, billPosted });
}
