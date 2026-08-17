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
