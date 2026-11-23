/**
 * A loan payment that came back — a check that bounced, a transfer returned. The only way to say
 * so was to delete the payment, which lost that it was sent at all and the fees it cost.
 *
 * Marked returned, the payment moves out of loan_payments into returned_payments: everything that
 * totals loan payments (the tracker, costs, cash flow, P&L, the pay planner) stops counting it with
 * no change of its own, and the month is owed again. Its pending item on the bank account goes (the
 * money never left); the owner's bank's returned-item fee becomes an expense on the loan's property;
 * a fee the lender charges for it is owed with that month. Undo puts the payment back as it was.
 */
import { db } from '../config/db';
import { pendingForLoanPayment } from './pendingMoney';

export const RETURN_REASONS = {
  NSF: 'not enough money in the account',
  STOP_PAYMENT: 'a stop payment',
  ACCOUNT_CLOSED: 'the account was closed',
  OTHER: 'returned',
} as const;
export type ReturnReason = keyof typeof RETURN_REASONS;

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function markPaymentReturned(
  userId: string, loanId: string, paymentId: string,
  opts: { returnedOn: string; reason?: ReturnReason | null; bankFee?: number | null; lenderFee?: number | null },
) {
  const loan = await db.loan.findFirst({
    where: { id: loanId, userId },
    select: { id: true, lender: true, propertyId: true, isPersonal: true, memberId: true, payFromBankAccountId: true },
  });
  if (!loan) return null;
  const p = await db.loanPayment.findFirst({ where: { id: paymentId, loanId } });
  if (!p) return null;
  const pending = await db.pendingOutflow.findFirst({ where: { userId, sourceRef: `loanpay:${p.id}`, cleared: false }, select: { id: true, bankAccountId: true } });
  const returnedOn = new Date(`${opts.returnedOn}T00:00:00.000Z`);
  const reason = opts.reason ?? 'OTHER';
  const what = p.method === 'CHECK' || p.method === 'CHECK_DROPPED' ? 'check' : 'payment';

  // The owner's bank's fee for the returned item: an expense on the loan's property (or personal).
  let bankFeeExpenseId: string | null = null;
  if (opts.bankFee && opts.bankFee > 0) {
    const acctId = pending?.bankAccountId ?? loan.payFromBankAccountId;
    const acct = acctId ? await db.bankAccount.findFirst({ where: { id: acctId, userId }, select: { name: true, nickname: true, bank: true, last4: true } }) : null;
    const e = await db.expense.create({
      data: {
        userId, propertyId: loan.propertyId, isPersonal: loan.isPersonal, ...(loan.isPersonal ? { memberId: loan.memberId } : {}),
        category: 'OTHER', amount: r2(opts.bankFee), date: returnedOn,
        vendor: acct ? (acct.bank || acct.nickname || acct.name) : 'Bank',
        description: `Returned ${what} fee: the $${Number(p.amount).toFixed(2)} ${what} to ${loan.lender} came back (${RETURN_REASONS[reason]})${acct?.last4 ? ` · ··${acct.last4}` : ''}`,
      },
      select: { id: true },
    });
    bankFeeExpenseId = e.id;
  }

  const [returned] = await db.$transaction([
    db.returnedPayment.create({
      data: {
        userId, loanId, amount: p.amount, sentOn: p.date, periodDate: p.periodDate, method: p.method, confirmationNumber: p.confirmationNumber,
        billAmount: p.billAmount, lateFee: p.lateFee, notes: p.notes, pendingBankAccountId: pending?.bankAccountId ?? null,
        returnedOn, reason, bankFee: opts.bankFee && opts.bankFee > 0 ? r2(opts.bankFee) : null, bankFeeExpenseId,
        lenderFee: opts.lenderFee && opts.lenderFee > 0 ? r2(opts.lenderFee) : null,
      },
    }),
    db.loanPayment.delete({ where: { id: p.id } }),
    // It never left the account (or came back to it): nothing pending there.
    db.pendingOutflow.deleteMany({ where: { userId, cleared: false, sourceRef: `loanpay:${p.id}` } }),
  ]);
  return returned;
}

/** Not returned after all: the payment goes back as it was logged, with its pending item and without the bank's fee. */
export async function undoPaymentReturned(userId: string, loanId: string, returnedId: string) {
  const r = await db.returnedPayment.findFirst({ where: { id: returnedId, loanId, userId }, include: { loan: { select: { lender: true } } } });
  if (!r) return null;
  const payment = await db.loanPayment.create({
    data: {
      loanId, date: r.sentOn, amount: r.amount, periodDate: r.periodDate, method: r.method, confirmationNumber: r.confirmationNumber,
      billAmount: r.billAmount, lateFee: r.lateFee, notes: r.notes,
    },
  });
  if (r.pendingBankAccountId) {
    await pendingForLoanPayment(userId, r.pendingBankAccountId, { id: payment.id, amount: Number(payment.amount), date: payment.date, method: payment.method, confirmationNumber: payment.confirmationNumber }, r.loan.lender)
      .catch(() => null);
  }
  if (r.bankFeeExpenseId) await db.expense.deleteMany({ where: { id: r.bankFeeExpenseId, userId } });
  await db.returnedPayment.delete({ where: { id: r.id } });
  return payment;
}

/** Returned payments for the months [from, to] (by the month each was for), as the tracker shows them. */
export async function returnedBetween(loanIds: string[], from: string, to: string) {
  if (!loanIds.length) return [];
  const start = new Date(`${from}-01T00:00:00.000Z`);
  const [ty, tm] = to.split('-').map(Number);
  const end = new Date(Date.UTC(ty, tm, 1));
  const rows = await db.returnedPayment.findMany({
    where: { loanId: { in: loanIds }, OR: [{ periodDate: { gte: start, lt: end } }, { periodDate: null, sentOn: { gte: start, lt: end } }] },
    orderBy: { sentOn: 'asc' },
  });
  return rows.map(x => ({
    id: x.id, loanId: x.loanId, month: (x.periodDate ?? x.sentOn).toISOString().slice(0, 7),
    amount: Number(x.amount), sentOn: x.sentOn.toISOString().slice(0, 10), returnedOn: x.returnedOn.toISOString().slice(0, 10),
    reason: (x.reason ?? 'OTHER') as ReturnReason, method: x.method, confirmationNumber: x.confirmationNumber,
    bankFee: x.bankFee != null ? Number(x.bankFee) : null, lenderFee: x.lenderFee != null ? Number(x.lenderFee) : null,
  }));
}
