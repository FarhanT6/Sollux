import { db } from '../config/db';
import { allocateAccountPayments } from '../lib/paymentAllocation';

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
    select: { id: true, utilityAccountId: true, amount: true, status: true, statementId: true, planApplied: true, towardPlan: true },
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
  if (!bill && !payment.towardPlan) return 0;
  // The installment billed inside the bill (SDG&E): paying the bill pays it,
  // and the bill already counts it off the plan.
  if (bill && Number(bill.paymentPlanAmount ?? 0) > 0) return 0;
  // Logged as an installment: all of it comes off the plan (less its fee).
  if (payment.towardPlan) {
    const applied = Number(Math.min(Math.max(0, Number(payment.amount) - Number(plan.installmentFee ?? 0)), remaining).toFixed(2));
    if (applied <= 0) return 0;
    const left = Number((remaining - applied).toFixed(2));
    await db.paymentPlan.update({ where: { id: plan.id }, data: { remainingBalance: left, status: left <= 0.005 ? 'COMPLETED' : 'ACTIVE' } });
    await db.payment.update({ where: { id: payment.id }, data: { planApplied: applied } });
    return applied;
  }
  if (!bill) return 0;

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

/**
 * Apply a payment to the loan linked to the account.
 *
 * A pre-need contract or an installment loan billed like a utility (Eternal
 * Hills) carries a Loan record on the account. Each payment logged on the
 * account is a payment on that contract, so the loan's balance comes down
 * by it — the whole amount, since these contracts are billed as flat
 * installments — less what the payment spent on the bill's fees: a late fee
 * is the lender's charge, not repayment (Capital Premium Financing's $127.48
 * was the $121.41 installment and a $6.07 late fee, and all of it came off
 * the balance). Kept on the payment so an edit or deletion puts it back.
 */
export async function applyPaymentToLoan(paymentId: string): Promise<number> {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, utilityAccountId: true, amount: true, status: true, loanApplied: true },
  });
  if (!payment) return 0;

  await unapplyPaymentFromLoan(payment.id);
  if (Number(payment.loanApplied ?? 0) > 0) {
    await db.payment.update({ where: { id: payment.id }, data: { loanApplied: null } });
  }

  const loan = await db.loan.findUnique({ where: { utilityAccountId: payment.utilityAccountId } });
  if (!loan || !loan.isActive || loan.currentBalance == null) return 0;
  if (payment.status !== 'PAID' && payment.status !== 'PARTIAL') return 0;
  const balance = Number(loan.currentBalance);
  if (balance <= 0.005) return 0;

  const toFees = await feesPaidBy(payment.id, payment.utilityAccountId);
  const applied = Number(Math.min(Number(payment.amount) - toFees, balance).toFixed(2));
  if (applied <= 0) return 0;
  const newBalance = Number((balance - applied).toFixed(2));
  await db.loan.update({ where: { id: loan.id }, data: { currentBalance: newBalance, ...(newBalance <= 0.005 ? { isActive: false } : {}) } });
  await db.payment.update({ where: { id: payment.id }, data: { loanApplied: applied } });
  return applied;
}

/** What a payment spent on bills' fees, as the account's payment allocation applies it. */
async function feesPaidBy(paymentId: string, utilityAccountId: string): Promise<number> {
  const [stmts, pays] = await Promise.all([
    db.statement.findMany({ where: { utilityAccountId, isDownPayment: false }, select: { id: true, utilityAccountId: true, statementDate: true, billingPeriodEnd: true, amountDue: true, pastDueCarried: true, penaltiesFees: true, paymentPlanAmount: true } }),
    db.payment.findMany({ where: { utilityAccountId }, select: { id: true, utilityAccountId: true, paymentDate: true, amount: true, feeAmount: true, status: true, statementId: true, lateFeeAdded: true, feesAddedJson: true } }),
  ]);
  return Math.max(0, Number(allocateAccountPayments(stmts, pays).get(paymentId)?.toFees ?? 0));
}

/**
 * Payments already taken off a loan in full although part of them paid a
 * bill's fee: taken off again by the rule above. Runs when the workers start;
 * a payment already right is left alone, so running it again changes nothing.
 */
export async function reapplyLoanPaymentsLessFees(): Promise<number> {
  const paid = await db.payment.findMany({ where: { loanApplied: { gt: 0 } }, select: { id: true, utilityAccountId: true, amount: true, loanApplied: true } });
  let fixed = 0;
  for (const p of paid) {
    const fees = await feesPaidBy(p.id, p.utilityAccountId);
    if (fees > 0.005 && Math.abs(Number(p.loanApplied) - (Number(p.amount) - fees)) > 0.01) { await applyPaymentToLoan(p.id); fixed++; }
  }
  return fixed;
}

/** Put back on the loan whatever a payment about to be deleted had taken off it. */
export async function unapplyPaymentFromLoan(paymentId: string): Promise<void> {
  const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { utilityAccountId: true, loanApplied: true } });
  const previously = Number(payment?.loanApplied ?? 0);
  if (!payment || previously <= 0) return;
  const loan = await db.loan.findUnique({ where: { utilityAccountId: payment.utilityAccountId } });
  if (!loan) return;
  await db.loan.update({
    where: { id: loan.id },
    data: { currentBalance: Number((Number(loan.currentBalance ?? 0) + previously).toFixed(2)), isActive: true },
  });
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
