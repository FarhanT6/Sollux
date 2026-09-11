import { Prisma } from '@prisma/client';

/**
 * What a payment actually went toward.
 *
 * A payment is one number; the bill it answers is several — a late fee, a
 * balance carried from earlier, a payment-plan installment, this period's
 * charge — and a processing fee may ride on top. Providers apply money in a
 * fixed order (fees and penalties, then the oldest balance, then the
 * current charge), so the same order is used here to say where each dollar
 * landed. Earlier payments against the same bill are taken first, so a
 * second payment in a cycle is applied to what the first left open.
 */

const num = (v: Prisma.Decimal | number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isNaN(n) ? 0 : n;
};

export interface StatementForAllocation {
  id: string;
  statementDate: Date;
  billingPeriodEnd: Date | null;
  amountDue: Prisma.Decimal | number | null;
  pastDueCarried: Prisma.Decimal | number | null;
  penaltiesFees: Prisma.Decimal | number | null;
  paymentPlanAmount: Prisma.Decimal | number | null;
}

export interface PaymentForAllocation {
  id: string;
  paymentDate: Date;
  amount: Prisma.Decimal | number;
  feeAmount?: Prisma.Decimal | number | null;
  status: string;
  statementId?: string | null;
}

export interface PaymentBreakdown {
  /** The bill this payment was applied to. */
  statementId: string | null;
  statementLabel: string | null;     // YYYY-MM of the period
  toFees: number;                    // late fees / penalties on the bill
  toPastDue: number;                 // balance carried from earlier periods
  toInstallment: number;             // payment-plan installment inside the bill
  toCurrent: number;                 // this period's own charge
  overpaid: number;                  // beyond everything open — a credit
  creditUsed: number;                // a carried credit that reduced what was owed
  transactionFee: number;            // processing fee paid on top, not part of the bill
  totalOut: number;                  // amount + transaction fee
  remainingAfter: number;            // what the bill still had open after this payment
}

/**
 * Allocate every payment on one account. `statements` and `payments` are the
 * account's, in any order.
 */
export function allocateAccountPayments(
  statements: StatementForAllocation[],
  payments: PaymentForAllocation[],
): Map<string, PaymentBreakdown> {
  const byDateDesc = [...statements].sort((a, b) => b.statementDate.getTime() - a.statementDate.getTime());
  const ordered = [...payments].sort((a, b) => a.paymentDate.getTime() - b.paymentDate.getTime());
  const out = new Map<string, PaymentBreakdown>();

  // Open balances per statement, consumed as payments are walked in date order.
  const open = new Map<string, { fees: number; pastDue: number; installment: number; current: number; credit: number }>();
  const openFor = (s: StatementForAllocation) => {
    let o = open.get(s.id);
    if (!o) {
      const carried = num(s.pastDueCarried);
      const fees = Math.max(num(s.penaltiesFees), 0);
      const installment = Math.max(num(s.paymentPlanAmount), 0);
      const current = Math.max(num(s.amountDue) - fees - installment, 0);
      o = { fees, pastDue: Math.max(carried, 0), installment, current, credit: Math.max(-carried, 0) };
      open.set(s.id, o);
    }
    return o;
  };

  for (const p of ordered) {
    const fee = Math.max(num(p.feeAmount), 0);
    const amount = num(p.amount);
    const target = (p.statementId && statements.find(s => s.id === p.statementId))
      || byDateDesc.find(s => s.statementDate.getTime() <= p.paymentDate.getTime() + 86400000)
      || null;
    // Named as the statement list names it: by the month the bill was issued.
    const label = target ? target.statementDate.toISOString().slice(0, 7) : null;

    if (!target || p.status === 'FAILED') {
      out.set(p.id, { statementId: target?.id ?? null, statementLabel: label, toFees: 0, toPastDue: 0, toInstallment: 0, toCurrent: 0, overpaid: p.status === 'FAILED' ? 0 : amount, creditUsed: 0, transactionFee: fee, totalOut: amount + fee, remainingAfter: 0 });
      continue;
    }
    const o = openFor(target);
    // A carried credit reduces what the bill asks for before any cash does.
    let creditUsed = 0;
    if (o.credit > 0) {
      for (const k of ['fees', 'pastDue', 'installment', 'current'] as const) {
        const take = Math.min(o[k], o.credit); o[k] -= take; o.credit -= take; creditUsed += take;
      }
    }
    let left = amount;
    const take = (k: 'fees' | 'pastDue' | 'installment' | 'current') => { const t = Math.min(o[k], left); o[k] -= t; left -= t; return t; };
    const toFees = take('fees');
    const toPastDue = take('pastDue');
    const toInstallment = take('installment');
    const toCurrent = take('current');
    const r2 = (n: number) => Math.round(n * 100) / 100;
    out.set(p.id, {
      statementId: target.id, statementLabel: label,
      toFees: r2(toFees), toPastDue: r2(toPastDue), toInstallment: r2(toInstallment), toCurrent: r2(toCurrent),
      overpaid: r2(left), creditUsed: r2(creditUsed), transactionFee: r2(fee), totalOut: r2(amount + fee),
      remainingAfter: r2(o.fees + o.pastDue + o.installment + o.current),
    });
  }
  return out;
}
