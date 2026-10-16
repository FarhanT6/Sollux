/**
 * Late fees charged on their own, for the tenants whose lease has
 * "Charge the late fee automatically" on.
 *
 * Once the rent due day plus the grace days pass and the month is not paid in
 * full by then, the fee (flat, or a percent of rent) is added to that month:
 * it shows in the month's overdue amount and rolls into arrears with the rest
 * of the month if it is still unpaid at month end. One fee per month; the
 * owner can waive it.
 */
import { db } from '../config/db';
import { monthRentDue } from '../lib/rentDue';

const DAY = 24 * 3600 * 1000;

export function lateFeeFor(lease: { rentAmount: unknown; lateFeeAmount: unknown; lateFeePercent: number | null }): number | null {
  if (lease.lateFeeAmount != null && Number(lease.lateFeeAmount) > 0) return Number(lease.lateFeeAmount);
  if (lease.lateFeePercent != null && lease.lateFeePercent > 0) return Math.round(Number(lease.rentAmount) * lease.lateFeePercent) / 100;
  return null;
}

/** The first moment a month's rent counts as late: the day after the due day plus grace days. */
export function lateFrom(period: Date, rentDueDay: number | null, graceDays: number | null): Date {
  const daysInMonth = new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 0)).getUTCDate();
  const due = Date.UTC(period.getUTCFullYear(), period.getUTCMonth(), Math.min(rentDueDay ?? 1, daysInMonth));
  return new Date(due + ((graceDays ?? 0) + 1) * DAY);
}

/**
 * Add this month's late fee to every lease that has it on and is late. Pass a
 * lease id to check just that one (when the owner turns the option on).
 */
export async function assessLateFees(now = new Date(), leaseId?: string): Promise<number> {
  const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const leases = await db.lease.findMany({
    where: { status: 'ACTIVE', autoLateFee: true, ...(leaseId ? { id: leaseId } : {}) },
    include: {
      rentCharges: { where: { periodDate: period, kind: 'LATE_FEE' }, select: { id: true } },
      rentPayments: { where: { periodDate: { gte: period, lt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) }, status: 'RECEIVED' } },
    },
  });
  let added = 0;
  for (const l of leases) {
    if (l.rentCharges.length) continue;
    const fee = lateFeeFor(l);
    if (!fee) continue;
    // The start month is due on the start date, not the usual due day before it.
    const due = monthRentDue(l, period);
    if (due <= 0) continue;
    const startsThisMonth = !!l.startDate && l.startDate.getUTCFullYear() === period.getUTCFullYear() && l.startDate.getUTCMonth() === period.getUTCMonth();
    const deadline = startsThisMonth
      ? new Date(Date.UTC(l.startDate!.getUTCFullYear(), l.startDate!.getUTCMonth(), l.startDate!.getUTCDate() + (l.lateFeeGraceDays ?? 0) + 1))
      : lateFrom(period, l.rentDueDay, l.lateFeeGraceDays);
    if (now < deadline) continue;
    // Paid in full by the deadline means on time, whatever came after.
    const onTime = l.rentPayments
      .filter(p => p.paidDate < deadline)
      .reduce((s, p) => s + Number(p.amount) - Number(p.appliedToArrears), 0);
    if (onTime >= due - 0.005) continue;
    await db.rentCharge.create({ data: { leaseId: l.id, periodDate: period, kind: 'LATE_FEE', amount: fee } }).catch(() => {});
    added++;
  }
  if (added) console.log(`[LateFees] added this month's late fee to ${added} lease(s)`);
  return added;
}

/** Remove a charge. One already rolled into arrears comes back off the balance. */
export async function waiveCharge(chargeId: string): Promise<void> {
  const c = await db.rentCharge.findUnique({ where: { id: chargeId }, include: { lease: { select: { arrearsCaughtUpThrough: true, arrearsBalance: true } } } });
  if (!c) return;
  await db.rentCharge.delete({ where: { id: c.id } });
  const rolled = c.lease.arrearsCaughtUpThrough && c.periodDate.getTime() <= c.lease.arrearsCaughtUpThrough.getTime();
  if (rolled) {
    const back = Math.min(Number(c.amount), Math.max(0, Number(c.lease.arrearsBalance)));
    if (back > 0) await db.lease.update({ where: { id: c.leaseId }, data: { arrearsBalance: { decrement: back } } });
  }
}
