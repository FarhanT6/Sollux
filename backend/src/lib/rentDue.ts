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
