import { db } from '../config/db';
import type { RentPaymentMethod } from '@prisma/client';
import { monthRentDue } from '../lib/rentDue';

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

export interface Split {
  /** Pays down the balance from earlier months; not this month's rent. */
  toArrears: number;
  /** This month's rent, for a month already rolled into the balance: counts toward the month and comes off the balance too. */
  settledRolled: number;
}

/**
 * Work out how a payment divides between the month's rent and the balance
 * (arrears).
 *
 *  - CURRENT (the default): the month's rent and late fees first, the
 *    remainder against arrears.
 *  - ARREARS: arrears first, the remainder to the month.
 *
 * A month that has already ended rolled its unpaid rent into arrears. Paid
 * "this month first", it is still that month's rent (the month reads as paid)
 * and it also comes off the balance, where the month was being carried. It
 * used to go to arrears whatever the order, so a late-logged September payment
 * showed as "to arrears" and September as unpaid.
 * Never more than what is owed, so an overpayment is a credit, not a negative balance.
 */
export async function splitPayment(
  leaseId: string, periodDate: Date, amount: number, excludePaymentId?: string, applyTo?: ApplyTo | null,
): Promise<Split> {
  const lease = await db.lease.findUnique({
    where: { id: leaseId },
    select: { rentAmount: true, arrearsBalance: true, paymentsApplyTo: true, arrearsCaughtUpThrough: true, startDate: true, firstMonthRent: true },
  });
  if (!lease) return { toArrears: 0, settledRolled: 0 };
  const arrears = Math.max(0, Number(lease.arrearsBalance));
  const rolledIn = !!lease.arrearsCaughtUpThrough && periodDate.getTime() <= lease.arrearsCaughtUpThrough.getTime();
  const order = applyTo ?? (lease.paymentsApplyTo === 'ARREARS' ? 'ARREARS' : 'CURRENT');
  if (order === 'ARREARS') return { toArrears: round2(Math.min(amount, arrears)), settledRolled: 0 };

  const due = Math.max(0, monthRentDue(lease, periodDate) + await chargesFor(leaseId, periodDate) - await creditedTo(leaseId, periodDate, excludePaymentId));
  const toMonth = Math.min(amount, due);
  const settledRolled = rolledIn ? Math.min(toMonth, arrears) : 0;
  const toArrears = Math.min(amount - toMonth, arrears - settledRolled);
  return { toArrears: round2(Math.max(0, toArrears)), settledRolled: round2(settledRolled) };
}

/** Create a rent payment and move the lease's arrears balance to match. */
export async function recordRentPayment(input: RecordPaymentInput) {
  const status = input.status ?? 'RECEIVED';
  // A pending payment pays down nothing until it arrives.
  const split: Split = status === 'PENDING'
    ? { toArrears: 0, settledRolled: 0 }
    : input.appliedToArrears != null ? { toArrears: input.appliedToArrears, settledRolled: 0 }
    : await splitPayment(input.leaseId, input.periodDate, input.amount, undefined, input.applyTo);
  const appliedToArrears = split.toArrears;

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
      settledRolledRent: split.settledRolled,
    },
  });

  const offBalance = round2(appliedToArrears + split.settledRolled);
  if (offBalance > 0) {
    await db.lease.update({
      where: { id: input.leaseId },
      data: { arrearsBalance: { decrement: offBalance } },
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
}): Promise<Split> {
  const existing = await db.rentPayment.findUnique({
    where: { id: paymentId },
    select: { leaseId: true, appliedToArrears: true, settledRolledRent: true, applyTo: true },
  });
  if (!existing) return { toArrears: 0, settledRolled: 0 };

  // Reverse the old effect first, on whichever lease it applied to.
  const previous = round2(Number(existing.appliedToArrears) + Number(existing.settledRolledRent));
  if (previous > 0) {
    await db.lease.update({
      where: { id: existing.leaseId },
      data: { arrearsBalance: { increment: previous } },
    });
  }

  const split: Split = next.status === 'PENDING'
    ? { toArrears: 0, settledRolled: 0 }
    : next.appliedToArrears != null ? { toArrears: next.appliedToArrears, settledRolled: 0 }
    : await splitPayment(next.leaseId, next.periodDate, next.amount, paymentId,
      next.applyTo !== undefined ? next.applyTo : (existing.applyTo as ApplyTo | null));

  const off = round2(split.toArrears + split.settledRolled);
  if (off > 0) {
    await db.lease.update({
      where: { id: next.leaseId },
      data: { arrearsBalance: { decrement: off } },
    });
  }
  return split;
}
