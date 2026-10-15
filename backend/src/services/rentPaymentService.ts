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
  /** PENDING money is committed but not received — see splitPayment. */
  status?: 'PENDING' | 'RECEIVED';
  expectedDate?: Date | null;
  /** Omit to split automatically; pass a number to force the arrears portion. */
  appliedToArrears?: number;
  /** Where this payment goes first; omit to use the lease's setting. */
  applyTo?: ApplyTo | null;
}

export type ApplyTo = 'CURRENT' | 'ARREARS';

const round2 = (n: number) => Math.round(n * 100) / 100;
const nextPeriod = (p: Date) => new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth() + 1, 1));

/** Late fees and other charges added to one month. */
export async function chargesFor(leaseId: string, periodDate: Date): Promise<number> {
  const r = await db.rentCharge.aggregate({ where: { leaseId, periodDate: { gte: periodDate, lt: nextPeriod(periodDate) } }, _sum: { amount: true } });
  return Number(r._sum.amount ?? 0);
}

/**
 * What received payments put toward one month's rent: each payment less the
 * part of it that paid down the balance.
 */
export async function creditedTo(leaseId: string, periodDate: Date, excludePaymentId?: string): Promise<number> {
  const rows = await db.rentPayment.findMany({
    where: {
      leaseId, periodDate: { gte: periodDate, lt: nextPeriod(periodDate) },
      // Pending money hasn't arrived, so it can't have covered any rent.
      status: 'RECEIVED',
      // When re-splitting an edited payment, its own old row must not count
      // as prior coverage of the period.
      ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}),
    },
    select: { amount: true, appliedToArrears: true },
  });
  return rows.reduce((s, p) => s + Number(p.amount) - Number(p.appliedToArrears), 0);
}

/**
 * Work out how much of a payment pays down the balance (arrears); the rest
 * goes to the month's rent.
 *
 *  - CURRENT (the default): the month's rent and late fees first, the
 *    remainder against arrears.
 *  - ARREARS: arrears first, the remainder to the month.
 *
 * A month that has already rolled into arrears (an earlier month) is paid
 * through arrears whatever the order, or paying it would not move the balance.
 * Never more than what is owed, so an overpayment is a credit, not a negative balance.
 */
export async function splitPayment(
  leaseId: string, periodDate: Date, amount: number, excludePaymentId?: string, applyTo?: ApplyTo | null,
): Promise<number> {
  const lease = await db.lease.findUnique({
    where: { id: leaseId },
    select: { rentAmount: true, arrearsBalance: true, paymentsApplyTo: true, arrearsCaughtUpThrough: true },
  });
  if (!lease) return 0;
  const arrears = Math.max(0, Number(lease.arrearsBalance));
  const rolledIn = !!lease.arrearsCaughtUpThrough && periodDate.getTime() <= lease.arrearsCaughtUpThrough.getTime();
  const order = applyTo ?? (lease.paymentsApplyTo === 'ARREARS' ? 'ARREARS' : 'CURRENT');
  if (rolledIn || order === 'ARREARS') return round2(Math.min(amount, arrears));

  const due = Number(lease.rentAmount) + await chargesFor(leaseId, periodDate) - await creditedTo(leaseId, periodDate, excludePaymentId);
  const excess = Math.max(0, amount - Math.max(0, due));
  return round2(Math.min(excess, arrears));
}

/** Create a rent payment and move the lease's arrears balance to match. */
export async function recordRentPayment(input: RecordPaymentInput) {
  const status = input.status ?? 'RECEIVED';
  // A pending payment pays down nothing until it arrives.
  const appliedToArrears = status === 'PENDING'
    ? 0
    : input.appliedToArrears ?? await splitPayment(input.leaseId, input.periodDate, input.amount, undefined, input.applyTo);

  const payment = await db.rentPayment.create({
    data: {
      leaseId: input.leaseId,
      periodDate: input.periodDate,
      amount: input.amount,
      paidDate: input.paidDate,
      method: input.method,
      status,
      expectedDate: input.expectedDate ?? null,
      bankAccountId: input.bankAccountId ?? null,
      notes: input.notes ?? null,
      applyTo: input.applyTo ?? null,
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

/**
 * Re-apply a payment's arrears effect after it is edited. Changing the amount,
 * the period, or the pending/received status all change how much of it should
 * pay down the balance, so the old effect is reversed and a fresh split
 * applied — anything less leaves the balance drifting from the payments.
 */
export async function repriceRentPayment(paymentId: string, next: {
  leaseId: string; periodDate: Date; amount: number; status: 'PENDING' | 'RECEIVED';
  appliedToArrears?: number;
  /** undefined keeps the payment's earlier choice; null goes back to the lease's setting. */
  applyTo?: ApplyTo | null;
}) {
  const existing = await db.rentPayment.findUnique({
    where: { id: paymentId },
    select: { leaseId: true, appliedToArrears: true, applyTo: true },
  });
  if (!existing) return 0;

  // Reverse the old effect first, on whichever lease it applied to.
  const previous = Number(existing.appliedToArrears);
  if (previous > 0) {
    await db.lease.update({
      where: { id: existing.leaseId },
      data: { arrearsBalance: { increment: previous } },
    });
  }

  const applied = next.status === 'PENDING'
    ? 0
    : next.appliedToArrears ?? await splitPayment(next.leaseId, next.periodDate, next.amount, paymentId,
      next.applyTo !== undefined ? next.applyTo : (existing.applyTo as ApplyTo | null));

  if (applied > 0) {
    await db.lease.update({
      where: { id: next.leaseId },
      data: { arrearsBalance: { decrement: applied } },
    });
  }
  return applied;
}
