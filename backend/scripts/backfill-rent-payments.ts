// Reconstructs a monthly RentPayment history from each lease's start date
// up to (but not including) the current in-progress month, so tenant
// payment history has real rows instead of being blank before you started
// actively logging payments. This is an ESTIMATE, not verified real
// payment history — every inserted row is tagged in its notes field.
//
// Reconciliation with arrears: the lease's current `arrearsBalance` is
// treated as ground truth. Months are assumed paid in full starting from
// move-in, EXCEPT the most recent backfilled months are left unpaid (or
// partially paid on the boundary month) so the total shortfall across the
// backfilled window exactly equals the arrears balance already on file.
// This does NOT fabricate a payment history that contradicts what you
// already know about a delinquent tenant.
//
// Safety rules:
//   - Only leases with ZERO existing RentPayment rows are touched. A lease
//     with any real payment history (even one row) is skipped entirely —
//     this script never edits, back-dates around, or duplicates existing
//     records.
//   - The current calendar month is never backfilled — that's left for
//     real logging via the app.
//   - Months marked as fully unpaid get NO row inserted at all (consistent
//     with how the Budget page already computes "collected": absence of a
//     payment record for a period means $0 collected for that period).
//
// Usage:
//   cd backend
//   DATABASE_URL=<neon url> npx tsx scripts/backfill-rent-payments.ts          # dry run, prints a plan
//   DATABASE_URL=<neon url> DRY_RUN=false npx tsx scripts/backfill-rent-payments.ts   # actually writes

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN !== 'false';
const BACKFILL_TAG = 'Backfilled estimate from move-in date — not a verified transaction.';

function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

async function main() {
  const leases = await db.lease.findMany({
    include: { _count: { select: { rentPayments: true } }, unit: { include: { property: true } }, leaseTenants: { include: { tenant: true } } },
  });
  console.log(`${leases.length} total leases. DRY_RUN=${DRY_RUN}`);

  const today = new Date();
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  let backfilled = 0, skippedHasHistory = 0, skippedNoRoom = 0;

  for (const lease of leases) {
    if (lease._count.rentPayments > 0) { skippedHasHistory++; continue; }

    const start = new Date(lease.startDate);
    const startMonth = new Date(start.getFullYear(), start.getMonth(), 1);
    const monthsToBackfill = monthsBetween(startMonth, currentMonthStart); // excludes the current month itself
    if (monthsToBackfill <= 0) { skippedNoRoom++; continue; }

    const rentAmount = Number(lease.rentAmount);
    const arrears = Number(lease.arrearsBalance ?? 0);

    // Build the month list oldest -> newest, then allocate the shortfall
    // starting from the newest end.
    const months: Date[] = [];
    for (let i = 0; i < monthsToBackfill; i++) months.push(new Date(startMonth.getFullYear(), startMonth.getMonth() + i, 1));

    let remainingArrears = arrears;
    const rows: { periodDate: Date; amount: number }[] = [];
    for (let i = months.length - 1; i >= 0; i--) {
      let paid: number;
      if (remainingArrears >= rentAmount) { paid = 0; remainingArrears -= rentAmount; }
      else if (remainingArrears > 0) { paid = rentAmount - remainingArrears; remainingArrears = 0; }
      else { paid = rentAmount; }
      if (paid > 0) rows.push({ periodDate: months[i], amount: paid });
    }
    rows.reverse(); // back to chronological order

    const tenantName = lease.leaseTenants[0]?.tenant.fullName ?? 'Unknown tenant';
    const propertyLabel = lease.unit.property.nickname || lease.unit.property.address;
    console.log(`- ${tenantName} (${propertyLabel}, Unit ${lease.unit.unitLabel}): ${months.length} months since move-in, ${rows.length} paid rows, arrears $${arrears.toFixed(2)} reconciled onto the most recent months`);
    backfilled++;

    if (!DRY_RUN) {
      await db.rentPayment.createMany({
        data: rows.map(r => ({
          leaseId: lease.id,
          periodDate: r.periodDate,
          amount: Math.round(r.amount * 100) / 100,
          paidDate: r.periodDate,
          method: 'OTHER',
          notes: BACKFILL_TAG,
        })),
      });
    }
  }

  console.log(`\n${DRY_RUN ? 'Would backfill' : 'Backfilled'} ${backfilled} leases.`);
  console.log(`Skipped: ${skippedHasHistory} already have payment history, ${skippedNoRoom} moved in this month or later.`);
  if (DRY_RUN) console.log('\nThis was a dry run — nothing was written. Re-run with DRY_RUN=false to commit.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
