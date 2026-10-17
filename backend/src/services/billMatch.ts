/**
 * Is this bill already on file? One answer for every way a bill comes in —
 * a manual upload (routes/import.ts), a Drive folder (routes/drive.ts) and
 * the background intake (services/documentIntake.ts: the Drive worker, the
 * inbox agent, the portal agent).
 *
 * Each path used to carry its own copy of this lookup, and the two automatic
 * ones had only the first and last steps. A bill that states no billing
 * period of its own (insurance) or one read slightly differently each time
 * was never found again, and every re-read filed another copy: ten rows of
 * the same Hartford bill, SDG&E's September bill twice (#189, #241).
 *
 * The rules, in order:
 *   1. the billing period (not for insurance: its "period" is the policy
 *      term, shared by every bill of the term), starting within a week;
 *   2. an insurance installment: every row for the same installment — same
 *      due date within 5 days, or same issue date — is one bill; the one
 *      with payments survives and the rest fold into it;
 *   3. the same issue date, within a day;
 *   4. a scheduled installment (filed ahead from a policy's payment
 *      schedule) due within 5 days: the real bill takes its place;
 *   5. the issue month, against rows with no real period of their own (none,
 *      or one inferred as the whole calendar month).
 */
import type { Statement } from '@prisma/client';
import { db } from '../config/db';

const DAY = 86_400_000;

export interface BillIdentity {
  billingPeriodStart?: string | null;
  statementDate?: string | null;
  dueDate?: string | null;
  insurance?: unknown;
}

export async function findExistingBill(
  utilityAccountId: string,
  ex: BillIdentity,
  statementDate: Date,
  opts: { insuranceBill: boolean },
): Promise<Statement | null> {
  // 1. Billing period.
  if (ex.billingPeriodStart && !opts.insuranceBill) {
    const start = new Date(ex.billingPeriodStart);
    const hit = await db.statement.findFirst({
      where: { utilityAccountId, billingPeriodStart: { gte: new Date(start.getTime() - 7 * DAY), lte: new Date(start.getTime() + 7 * DAY) } },
    });
    if (hit) return hit;
  }

  // 2. Insurance installment twins.
  if (opts.insuranceBill && ex.dueDate) {
    const due = new Date(ex.dueDate);
    const twins = await db.statement.findMany({
      where: {
        utilityAccountId, isScheduled: false, isDownPayment: false,
        OR: [
          { dueDate: { gte: new Date(due.getTime() - 5 * DAY), lte: new Date(due.getTime() + 5 * DAY) } },
          { statementDate: { gte: new Date(statementDate.getTime() - DAY), lte: new Date(statementDate.getTime() + DAY) } },
        ],
      },
      include: { _count: { select: { payments: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (twins.length) {
      const survivor = [...twins].sort((a, b) => b._count.payments - a._count.payments)[0]!;
      for (const t of twins) {
        if (t.id === survivor.id) continue;
        await db.payment.updateMany({ where: { statementId: t.id }, data: { statementId: survivor.id } });
        await db.statement.delete({ where: { id: t.id } });
      }
      const { _count, ...row } = survivor;
      return row as Statement;
    }
  }

  // 3. Same issue date.
  if (ex.statementDate) {
    const hit = await db.statement.findFirst({
      where: { utilityAccountId, isScheduled: false, isDownPayment: false, statementDate: { gte: new Date(statementDate.getTime() - DAY), lte: new Date(statementDate.getTime() + DAY) } },
    });
    if (hit) return hit;
  }

  // 4. A scheduled installment this bill replaces.
  if (ex.dueDate) {
    const due = new Date(ex.dueDate);
    const hit = await db.statement.findFirst({
      where: { utilityAccountId, isScheduled: true, dueDate: { gte: new Date(due.getTime() - 5 * DAY), lte: new Date(due.getTime() + 5 * DAY) } },
    });
    if (hit) return hit;
  }

  // 5. The issue month, against a row with no real period. UTC boundaries:
  // statement dates are stored at midnight UTC. An inferred period runs from
  // the 1st, matched as a window because it was built in the server's zone.
  const monthStart = new Date(Date.UTC(statementDate.getUTCFullYear(), statementDate.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(statementDate.getUTCFullYear(), statementDate.getUTCMonth() + 1, 0, 23, 59, 59));
  const firstOfMonth = monthStart.getTime();
  return db.statement.findFirst({
    where: {
      utilityAccountId,
      statementDate: { gte: monthStart, lte: monthEnd },
      OR: [
        { billingPeriodStart: null },
        { billingPeriodStart: { gte: new Date(firstOfMonth - DAY), lte: new Date(firstOfMonth + DAY) } },
      ],
    },
  });
}
