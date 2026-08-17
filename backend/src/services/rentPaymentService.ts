import { db } from '../config/db';
import type { RentPaymentMethod } from '@prisma/client';

// How a rent payment is recorded, whether typed in by hand or applied from a
// matched bank transaction. Both paths go through here so the arrears split
// behaves identically — it used to live only in the manual route, so anything
// auto-applied from Plaid silently skipped it.

export interface RecordPaymentInput {
  leaseId: string;
  periodDate: Date;
  amount: number;
  paidDate: Date;
  method: RentPaymentMethod;
  bankAccountId?: string | null;
  notes?: string | null;
  /** Omit to split automatically; pass a number to force the arrears portion. */
  appliedToArrears?: number;
}

/**
 * Work out how much of a payment covers the period's rent and how much pays
 * down the balance. Rent for the period comes first; the remainder goes to
 * arrears, capped at what is actually owed so an overpayment becomes a credit
 * rather than a negative balance.
 */
export async function splitPayment(leaseId: string, periodDate: Date, amount: number): Promise<number> {
  const lease = await db.lease.findUnique({ where: { id: leaseId }, select: { rentAmount: true, arrearsBalance: true } });
  if (!lease) return 0;

  const periodEnd = new Date(Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth() + 1, 1));
  const prior = await db.rentPayment.aggregate({
    where: { leaseId, periodDate: { gte: periodDate, lt: periodEnd } },
    _sum: { amount: true },
  });

  const alreadyPaid = Number(prior._sum.amount ?? 0);
  const rentStillDue = Math.max(0, Number(lease.rentAmount) - alreadyPaid);
  const excess = Math.max(0, amount - rentStillDue);
  return Math.min(excess, Number(lease.arrearsBalance));
}

/** Create a rent payment and move the lease's arrears balance to match. */
export async function recordRentPayment(input: RecordPaymentInput) {
  const appliedToArrears = input.appliedToArrears ?? await splitPayment(input.leaseId, input.periodDate, input.amount);

  const payment = await db.rentPayment.create({
    data: {
      leaseId: input.leaseId,
      periodDate: input.periodDate,
      amount: input.amount,
      paidDate: input.paidDate,
      method: input.method,
      bankAccountId: input.bankAccountId ?? null,
      notes: input.notes ?? null,
      appliedToArrears,
    },
  });

  if (appliedToArrears > 0) {
    await db.lease.update({
      where: { id: input.leaseId },
      data: { arrearsBalance: { decrement: appliedToArrears } },
    });
  }

  return payment;
}

// The month a payment belongs to. Period dates are stored as midnight UTC on
// the 1st; building this from local getters would land it in the wrong month
// for any server not running UTC.
export function periodStartOf(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
