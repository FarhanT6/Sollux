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

// Roll a month's unpaid rent (and its late fees) into arrears once the month
// is over. Until then it is that month's overdue amount, shown on its own
// ("$1,550 overdue for October"); arrears are the months before it.
//
// It used to roll the month in as soon as its due day passed. The month was
// then counted twice (in arrears and as overdue), and a payment logged for it
// afterwards went to the month, so it never came off the arrears.
//
// What a month was paid is each received payment less the part of it that
// paid down arrears, so a payment the owner sent to the balance does not also
// count as covering the month.
//
// Idempotency: arrearsCaughtUpThrough marks the last month rolled in. A lease
// never rolled (null) is seeded to last month without adding anything: its
// arrearsBalance was entered by hand and covers the months before this one.
export async function accrueOverdueRent(now = new Date()): Promise<number> {
  const leases = await db.lease.findMany({
    where: { status: 'ACTIVE' },
    include: { rentPayments: true, rentCharges: true },
  });

  const periodStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const currentPeriod = periodStart(now);
  const lastPeriod = addMonths(currentPeriod, -1);
  const inPeriod = (d: Date, p: Date) => periodStart(new Date(d)).getTime() === p.getTime();
  const owedFor = (lease: typeof leases[number], p: Date) => {
    const credited = lease.rentPayments
      .filter(x => inPeriod(x.periodDate, p) && x.status === 'RECEIVED')
      .reduce((s, x) => s + Number(x.amount) - Number(x.appliedToArrears), 0);
    const charges = lease.rentCharges.filter(c => inPeriod(c.periodDate, p)).reduce((s, c) => s + Number(c.amount), 0);
    return Math.max(0, Math.round((Number(lease.rentAmount) + charges - credited) * 100) / 100);
  };

  let accrued = 0;
  for (const lease of leases) {
    if (!lease.arrearsCaughtUpThrough) {
      await db.lease.update({ where: { id: lease.id }, data: { arrearsCaughtUpThrough: lastPeriod } });
      continue;
    }

    // Once only: this month was rolled in early by the old rule. Take it back
    // out (what was unpaid when it was rolled in, on its due day) so it is
    // rolled in once, at month end, with everything paid toward it by then.
    if (periodStart(lease.arrearsCaughtUpThrough).getTime() >= currentPeriod.getTime()) {
      // A lease added this month was only seeded to this month, never rolled in.
      if (lease.createdAt.getTime() >= currentPeriod.getTime() - 24 * 3600 * 1000) {
        await db.lease.update({ where: { id: lease.id }, data: { arrearsCaughtUpThrough: lastPeriod } });
        continue;
      }
      const dueDay = lease.rentDueDay ?? 1;
      const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
      const rolledAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.min(dueDay, daysInMonth) + 1));
      const credited = lease.rentPayments
        .filter(x => inPeriod(x.periodDate, currentPeriod) && x.createdAt < rolledAt)
        .reduce((s, x) => s + Number(x.amount), 0);
      const wasAdded = Math.max(0, Math.round((Number(lease.rentAmount) - credited) * 100) / 100);
      const back = Math.min(wasAdded, Math.max(0, Number(lease.arrearsBalance)));
      await db.lease.update({
        where: { id: lease.id },
        data: { arrearsCaughtUpThrough: lastPeriod, ...(back > 0 ? { arrearsBalance: { decrement: back } } : {}) },
      });
      if (back > 0) console.log(`[Arrears] lease ${lease.id}: took ${back} for this month back out of arrears; it rolls in at month end`);
      continue;
    }

    let cursor = periodStart(lease.arrearsCaughtUpThrough);
    let shortfallTotal = 0;
    let lastAccrued: Date | null = null;
    // Every finished month after the last one rolled in.
    for (;;) {
      cursor = addMonths(cursor, 1);
      if (cursor.getTime() >= currentPeriod.getTime()) break;
      shortfallTotal += owedFor(lease, cursor);
      lastAccrued = cursor;
    }

    if (lastAccrued) {
      await db.lease.update({
        where: { id: lease.id },
        data: {
          ...(shortfallTotal > 0 ? { arrearsBalance: { increment: Math.round(shortfallTotal * 100) / 100 } } : {}),
          arrearsCaughtUpThrough: lastAccrued,
        },
      });
      if (shortfallTotal > 0) accrued++;
    }
  }

  if (accrued > 0) console.log(`[Arrears] Rolled last month's unpaid rent into arrears on ${accrued} lease(s)`);
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
