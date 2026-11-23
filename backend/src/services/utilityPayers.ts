import { db } from '../config/db';

const ym = (d: Date) => d.toISOString().slice(0, 7);

/**
 * A tenant who pays the utilities back with the rent: the lease bills utilities (a utility
 * reimbursement is set up), or the tenant's own money says so — more than the rent, but less than
 * two months of it, in at least three of the six months before. Their extra over the rent is the
 * utilities, not next month's rent: taken as rent paid ahead, a trailer park's tenants read as paid
 * for months they never paid.
 */
export async function paysUtilitiesWithRent(leaseId: string, before: Date): Promise<boolean> {
  const lease = await db.lease.findUnique({ where: { id: leaseId }, select: { rentAmount: true, utilityReimbursement: { select: { enabled: true } } } });
  if (!lease) return false;
  if (lease.utilityReimbursement?.enabled) return true;
  const rent = Number(lease.rentAmount ?? 0);
  if (!(rent > 0)) return false;
  const end = new Date(Date.UTC(before.getUTCFullYear(), before.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 6, 1));
  const [rents, utils] = await Promise.all([
    db.rentPayment.findMany({ where: { leaseId, status: 'RECEIVED', method: { not: 'CREDIT' }, paidDate: { gte: start, lt: end } }, select: { amount: true, paidDate: true } }),
    db.reimbursementPayment.findMany({ where: { leaseId, paidDate: { gte: start, lt: end } }, select: { amount: true, paidDate: true } }),
  ]);
  const byMonth = new Map<string, number>();
  for (const p of [...rents, ...utils]) byMonth.set(ym(p.paidDate), (byMonth.get(ym(p.paidDate)) ?? 0) + Number(p.amount));
  const over = [...byMonth.values()].filter(t => t > rent + 20 && t < 2 * rent - 20).length;
  return over >= 3;
}
