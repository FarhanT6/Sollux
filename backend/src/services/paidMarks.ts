import { db } from '../config/db';

/**
 * A payment logged against a bill lifts the owner's Unpaid mark on it — the
 * newer, more specific claim wins. And when the payments on a bill cover its
 * charge and everything it carried in, the bills before it are settled too:
 * the carried balance was them. Their Unpaid marks come off as well; the
 * $200 paid on an August student-loan bill of $50 + $100 past due paid July,
 * and July kept reading Overdue because the owner had marked it unpaid while
 * re-entering payments. Paid marks are left as they are.
 */
export async function liftMarksSettledBy(statementId: string | null | undefined): Promise<void> {
  if (!statementId) return;
  const bill = await db.statement.findUnique({
    where: { id: statementId },
    select: { id: true, utilityAccountId: true, statementDate: true, amountDue: true, pastDueCarried: true, trueUpDeferred: true, paidOverride: true },
  });
  if (!bill) return;
  const agg = await db.payment.aggregate({ where: { statementId, status: { in: ['PAID', 'PARTIAL'] } }, _sum: { amount: true } });
  const paid = Number(agg._sum.amount ?? 0);
  if (paid <= 0) return;
  if (bill.paidOverride === 'UNPAID') await db.statement.update({ where: { id: bill.id }, data: { paidOverride: null } });
  const carried = Number(bill.pastDueCarried ?? 0);
  const total = Number(bill.amountDue ?? 0) - Number(bill.trueUpDeferred ?? 0) + Math.max(0, carried);
  if (carried > 0 && paid >= total - 0.01) {
    await db.statement.updateMany({
      where: { utilityAccountId: bill.utilityAccountId, statementDate: { lt: bill.statementDate }, paidOverride: 'UNPAID' },
      data: { paidOverride: null },
    });
  }
}
