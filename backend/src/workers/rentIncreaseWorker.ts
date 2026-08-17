import { db } from '../config/db';

// Auto-apply scheduled rent increases whose effective date has passed.
//
// Rules:
//  - Only increases with a definite result are auto-applied: an explicit
//    newAmount, or a single percent. A percent RANGE (percentMax set) is left
//    for manual "Apply now", since the exact percent within the range is a
//    human decision.
//  - Per lease, due increases are applied oldest-first so they compound
//    correctly (each builds on the previous one's new rent).
//  - Each application updates the lease's current rent and writes a RentChange
//    history row, exactly like the manual apply path.
export async function applyDueRentIncreases(now = new Date()): Promise<number> {
  const due = await db.scheduledRentIncrease.findMany({
    where: { applied: false, effectiveDate: { lte: now } },
    include: { lease: true },
    orderBy: { effectiveDate: 'asc' },
  });

  let applied = 0;
  for (const si of due) {
    // Skip ranges — the actual percent is unknown, leave for manual apply.
    if (si.percentMax != null && si.percent != null) continue;

    // Re-read the lease inside the loop so multiple due increases on the same
    // lease compound off each other in order.
    const lease = await db.lease.findUnique({ where: { id: si.leaseId } });
    if (!lease) continue;

    const prev = Number(lease.rentAmount);
    const newAmount = si.newAmount != null
      ? Number(si.newAmount)
      : si.percent != null
        ? Math.round(prev * (1 + Number(si.percent) / 100) * 100) / 100
        : null;
    if (newAmount == null) continue; // nothing actionable

    await db.rentChange.create({
      data: {
        leaseId: lease.id,
        effectiveDate: si.effectiveDate,
        previousAmount: prev,
        newAmount,
        note: si.note || 'Scheduled increase (auto-applied)',
      },
    });
    await db.lease.update({ where: { id: lease.id }, data: { rentAmount: newAmount } });
    await db.scheduledRentIncrease.update({ where: { id: si.id }, data: { applied: true } });
    applied++;
  }

  if (applied > 0) console.log(`[RentIncrease] Auto-applied ${applied} due scheduled increase(s)`);
  return applied;
}

// Roll unpaid rent into arrears once its due date has passed.
//
// The rule: the CURRENT month's rent is not arrears until its due day passes
// unpaid. So we only accrue periods whose due date is strictly in the past.
//
// Idempotency: arrearsCaughtUpThrough marks the last period already rolled in.
// For a lease that has never been accrued (null), we seed it to the current
// period WITHOUT accruing anything — existing arrearsBalance values were
// entered by hand, and retroactively accruing every past month on top of them
// would double-count. Accrual therefore starts from the next period onward.
export async function accrueOverdueRent(now = new Date()): Promise<number> {
  const leases = await db.lease.findMany({
    where: { status: 'ACTIVE' },
    include: { rentPayments: true },
  });

  const periodStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
  const currentPeriod = periodStart(now);

  let accrued = 0;
  for (const lease of leases) {
    // Seed a lease that has never been accrued; don't touch its balance.
    if (!lease.arrearsCaughtUpThrough) {
      await db.lease.update({ where: { id: lease.id }, data: { arrearsCaughtUpThrough: currentPeriod } });
      continue;
    }

    const dueDay = lease.rentDueDay ?? 1;
    const rent = Number(lease.rentAmount);
    let cursor = periodStart(lease.arrearsCaughtUpThrough);
    let shortfallTotal = 0;
    let lastAccrued: Date | null = null;

    // Walk forward from the period after the last accrued one.
    for (;;) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      if (cursor > currentPeriod) break;

      // Due date for this period — clamp to the month's last day.
      const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const dueDate = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(dueDay, daysInMonth));
      // Not yet overdue (this is the "current month before its due date" case).
      if (dueDate >= now) break;

      const paid = lease.rentPayments
        .filter(p => periodStart(new Date(p.periodDate)).getTime() === cursor.getTime())
        .reduce((s, p) => s + Number(p.amount), 0);
      const shortfall = Math.max(0, Math.round((rent - paid) * 100) / 100);
      if (shortfall > 0) shortfallTotal += shortfall;
      lastAccrued = cursor;
    }

    if (lastAccrued) {
      await db.lease.update({
        where: { id: lease.id },
        data: {
          ...(shortfallTotal > 0 ? { arrearsBalance: { increment: shortfallTotal } } : {}),
          arrearsCaughtUpThrough: lastAccrued,
        },
      });
      if (shortfallTotal > 0) accrued++;
    }
  }

  if (accrued > 0) console.log(`[Arrears] Rolled overdue rent into arrears on ${accrued} lease(s)`);
  return accrued;
}

// A fixed-term lease that has passed its end date without being renewed
// continues month-to-month by default (holdover). Flip those to
// MONTH_TO_MONTH so rent roll / projections treat them correctly, keeping
// them ACTIVE — the tenant is still in place.
export async function rolloverExpiredLeases(now = new Date()): Promise<number> {
  const expired = await db.lease.findMany({
    where: {
      status: 'ACTIVE',
      leaseType: 'FIXED_TERM',
      endDate: { not: null, lt: now },
    },
    select: { id: true },
  });

  if (expired.length === 0) return 0;

  await db.lease.updateMany({
    where: { id: { in: expired.map(l => l.id) } },
    data: { leaseType: 'MONTH_TO_MONTH' },
  });
  console.log(`[LeaseRollover] ${expired.length} expired fixed-term lease(s) rolled to month-to-month`);
  return expired.length;
}
