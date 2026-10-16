/**
 * What a lease owes in rent for one month (mirrors backend lib/rentDue.ts).
 * A lease starting partway through a month owes only part of it: the
 * first-month rent set on the lease, else the rent for the days from the
 * start date to month end. Before its start month it owes nothing.
 */
import type { Lease } from '../types';

type LeaseRent = Pick<Lease, 'rentAmount' | 'startDate'> & { firstMonthRent?: number | string | null };

const ym = (iso: string) => iso.slice(0, 7);

/** The start month's rent when it is a partial month, or null when it is a full one. */
export function proratedFirstMonth(lease: LeaseRent): number | null {
  if (!lease.startDate) return null;
  if (lease.firstMonthRent != null && lease.firstMonthRent !== '') return Number(lease.firstMonthRent);
  return autoProrated(Number(lease.rentAmount), lease.startDate);
}

/** Rent for the days from the start date to the end of its month; null when it starts on the 1st. */
export function autoProrated(rent: number, startDate: string): number | null {
  const [y, m, d] = startDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d || d === 1) return null;
  const dim = new Date(y, m, 0).getDate();
  return Math.round(rent * (dim - d + 1) / dim * 100) / 100;
}

/** Rent owed for the month `monthKey` (YYYY-MM). */
export function monthRentDue(lease: LeaseRent, monthKey: string): number {
  const rent = Number(lease.rentAmount);
  if (!lease.startDate) return rent;
  const start = ym(lease.startDate);
  if (monthKey < start) return 0;
  if (monthKey === start) return proratedFirstMonth(lease) ?? rent;
  return rent;
}
