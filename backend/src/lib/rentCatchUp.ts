/**
 * Rent caught up: the months a tenant has lived in a unit with no payment on
 * record, which the owner says were paid. Pure, for tests; routes/catchUp.ts
 * gathers the facts and records the payments.
 *
 *  - from the move-in month (its rent prorated when they moved in partway,
 *    lib/rentDue) through `through`, never before they lived there
 *  - a month with any payment logged is left as it is, part payment or not
 *  - each month at the rent in effect then (the lease's recorded rent
 *    changes), not today's rent
 */
import { monthRentDue, type LeaseRent } from './rentDue';

export interface RentChangeFact { effectiveDate: Date; previousAmount: number | null; newAmount: number }

const ym = (d: Date) => d.toISOString().slice(0, 7);
const monthDate = (m: string) => new Date(`${m}-01T00:00:00.000Z`);

function monthsFrom(from: string, through: string): string[] {
  const out: string[] = [];
  let [y, mo] = from.split('-').map(Number);
  const [ty, tm] = through.split('-').map(Number);
  while ((y < ty || (y === ty && mo <= tm)) && out.length < 600) { out.push(`${y}-${String(mo).padStart(2, '0')}`); if (++mo > 12) { mo = 1; y++; } }
  return out;
}

/** The monthly rent in effect in a month: the last change on or before it, else the amount before the first change, else today's rent. */
export function rentInMonth(current: number, changes: RentChangeFact[], month: string): number {
  const sorted = [...changes].sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime());
  const before = sorted.filter(c => ym(c.effectiveDate) <= month);
  if (before.length) return Number(before[before.length - 1].newAmount);
  if (sorted.length && sorted[0].previousAmount != null) return Number(sorted[0].previousAmount);
  return current;
}

export function rentMonthsToCatchUp(
  lease: LeaseRent & { startDate: Date | null },
  changes: RentChangeFact[],
  paidMonths: Set<string>,
  through: string,
): { month: string; amount: number }[] {
  if (!lease.startDate) return [];
  return monthsFrom(ym(lease.startDate), through)
    .filter(m => !paidMonths.has(m))
    .map(m => {
      const rent = rentInMonth(Number(lease.rentAmount), changes, m);
      return { month: m, amount: Math.round(monthRentDue({ ...lease, rentAmount: rent }, monthDate(m)) * 100) / 100 };
    })
    .filter(x => x.amount > 0);
}
