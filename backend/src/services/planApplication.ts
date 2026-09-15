import { db } from '../config/db';

/**
 * Apply a payment to the account's payment plan.
 *
 * On an account with an active arrangement, a payment larger than the
 * bill's own charge is almost always the bill plus that month's
 * installment: Seabreeze's $1,793.65 eCheck against a $1,136.31 assessment
 * is $30 of fee and $627.34 off the plan. So whatever a payment covers
 * beyond the bill's charge and the plan's fee comes off the plan balance,
 * and the amount is kept on the payment so an edit or deletion puts it
 * back. A plan whose installment is billed inside each statement (SDG&E)
 * is left alone — the bill's charge already carries it.
 */
export async function applyPaymentToPlan(paymentId: string): Promise<number> {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, utilityAccountId: true, amount: true, status: true, statementId: true, planApplied: true },
  });
  if (!payment) return 0;

  // Reverse whatever this payment applied before, so a re-run is exact.
  await unapplyPaymentFromPlan(payment.id);
  if (Number(payment.planApplied ?? 0) > 0) {
    await db.payment.update({ where: { id: payment.id }, data: { planApplied: null } });
  }

  const plan = await db.paymentPlan.findUnique({ where: { utilityAccountId: payment.utilityAccountId } });
  if (!plan || plan.status !== 'ACTIVE') return 0;
  if (payment.status !== 'PAID' && payment.status !== 'PARTIAL') return 0;
  const remaining = Number(plan.remainingBalance);
  if (remaining <= 0.005) return 0;

  // The bill this payment answers: the one it is logged against, else the
  // newest. Its own charge is what the payment had to cover first.
  const bill = payment.statementId
    ? await db.statement.findUnique({ where: { id: payment.statementId }, select: { amountDue: true, paymentPlanAmount: true } })
    : await db.statement.findFirst({ where: { utilityAccountId: payment.utilityAccountId, isDownPayment: false }, orderBy: { statementDate: 'desc' }, select: { amountDue: true, paymentPlanAmount: true } });
  if (!bill) return 0;
  if (Number(bill.paymentPlanAmount ?? 0) > 0) return 0;   // installment already inside the bill

  const charge = Math.max(0, Number(bill.amountDue ?? 0));
  const fee = Number(plan.installmentFee ?? 0);
  const excess = Number((Number(payment.amount) - charge - fee).toFixed(2));
  // Less than a dollar over is rounding, not an installment.
  if (excess < 1) return 0;

  const applied = Number(Math.min(excess, remaining).toFixed(2));
  const newRemaining = Number((remaining - applied).toFixed(2));
  await db.paymentPlan.update({
    where: { id: plan.id },
    data: { remainingBalance: newRemaining, status: newRemaining <= 0.005 ? 'COMPLETED' : 'ACTIVE' },
  });
  await db.payment.update({ where: { id: payment.id }, data: { planApplied: applied } });
  return applied;
}

/** Put back on the plan whatever a payment about to be deleted had taken off it. */
export async function unapplyPaymentFromPlan(paymentId: string): Promise<void> {
  const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { utilityAccountId: true, planApplied: true } });
  const previously = Number(payment?.planApplied ?? 0);
  if (!payment || previously <= 0) return;
  const plan = await db.paymentPlan.findUnique({ where: { utilityAccountId: payment.utilityAccountId } });
  if (!plan) return;
  await db.paymentPlan.update({
    where: { id: plan.id },
    data: { remainingBalance: Number((Number(plan.remainingBalance) + previously).toFixed(2)), status: plan.status === 'COMPLETED' ? 'ACTIVE' : plan.status },
  });
}
