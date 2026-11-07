/**
 * What a lease owes in rent for one month.
 *
 * A lease that starts partway through a month owes only part of that month:
 * the first-month rent written on the lease when the owner set one (leases
 * say "prorated" in different ways: by days, on a 30-day month, or a figure
 * in the move-in costs), otherwise the rent for the days from the start date
 * to the month's end. From the next month it owes the full rent, and before
 * its start month it owes nothing.
 *
 * rentAmount is the total the tenant pays each month (rent plus utilities
 * billed on top), so the utilities are prorated with it.
 */
export type LeaseRent = { rentAmount: unknown; startDate: Date | null; firstMonthRent?: unknown };

const periodOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);

/** The rent for the start month when it is not a full month, or null when it is. */
export function proratedFirstMonth(lease: LeaseRent): number | null {
  if (!lease.startDate) return null;
  const day = lease.startDate.getUTCDate();
  if (lease.firstMonthRent != null) return Number(lease.firstMonthRent);
  if (day === 1) return null;
  const dim = new Date(Date.UTC(lease.startDate.getUTCFullYear(), lease.startDate.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.round(Number(lease.rentAmount) * (dim - day + 1) / dim * 100) / 100;
}

export function monthRentDue(lease: LeaseRent, period: Date): number {
  const rent = Number(lease.rentAmount);
  if (!lease.startDate) return rent;
  const start = periodOf(lease.startDate), p = periodOf(period);
  if (p < start) return 0;
  if (p === start) return proratedFirstMonth(lease) ?? rent;
  return rent;
}

/**
 * What each ended month still owes, read from the lease's back-rent balance.
 * Money pays the oldest rent first, so what is left unpaid is the newest:
 * $10,000 of back rent at $3,000 a month, rolled in through October, is
 * October, September and August in full and $1,000 of July — and June and
 * before are paid. Walks back from the last month rolled into
 * the balance, each month taking up to its rent. `months` are YYYY-MM keys
 * (newest first is not required); months after the last one rolled in are
 * left out (they are not in the balance yet).
 */
export function backRentByMonth(lease: LeaseRent & { arrearsBalance: unknown; arrearsCaughtUpThrough: Date | null }): Map<string, number> {
  const out = new Map<string, number>();
  if (!lease.arrearsCaughtUpThrough) return out;
  let left = Math.max(0, Number(lease.arrearsBalance ?? 0));
  const t = lease.arrearsCaughtUpThrough;
  let y = t.getUTCFullYear(), m = t.getUTCMonth();
  const start = lease.startDate ? periodOf(lease.startDate) : null;
  for (let i = 0; i < 240; i++) {
    const p = new Date(Date.UTC(y, m, 1));
    if (start != null && p.getTime() < start) break;
    const due = monthRentDue(lease, p);
    const owed = Math.round(Math.min(due, left) * 100) / 100;
    out.set(p.toISOString().slice(0, 7), owed);
    left = Math.round((left - owed) * 100) / 100;
    if (--m < 0) { m = 11; y--; }
  }
  return out;
}
