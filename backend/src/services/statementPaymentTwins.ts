/**
 * A payment recorded from a bill's "Payments Received" line, when the owner
 * has logged the same payment by hand, is the same money twice. The import
 * skips it when the hand-logged one is already there; this catches the other
 * order — the bill imported first, the payment logged after — and removes
 * the bill's copy. Kept: the owner's record, with its date, method and
 * confirmation number.
 *
 * The bill's copy is dated the day before the bill that printed it; the
 * hand-logged one was made during that bill's cycle (after the bill before
 * it), for the same amount.
 */
import { db } from '../config/db';

const MARK = '[from-statement:';

export async function dropStatementTwins(utilityAccountId: string): Promise<number> {
  const copies = await db.payment.findMany({
    where: { utilityAccountId, notes: { contains: MARK } },
    select: { id: true, amount: true, paymentDate: true },
  });
  if (!copies.length) return 0;
  const hand = await db.payment.findMany({
    // A payment with no notes is the owner's too (NOT on its own would leave out a null).
    where: { utilityAccountId, OR: [{ notes: null }, { NOT: { notes: { contains: MARK } } }], status: { not: 'FAILED' } },
    select: { id: true, amount: true, paymentDate: true },
  });
  const statements = await db.statement.findMany({ where: { utilityAccountId }, select: { statementDate: true }, orderBy: { statementDate: 'desc' } });
  const claimed = new Set<string>();
  let dropped = 0;
  for (const c of copies) {
    const confirmedBy = c.paymentDate.getTime() + 86_400_000;
    // The cycle the bill reported on: from the bill before it up to the bill.
    const prev = statements.find(s => s.statementDate.getTime() < c.paymentDate.getTime());
    const from = prev ? prev.statementDate.getTime() : confirmedBy - 45 * 86_400_000;
    const twin = hand.find(h => !claimed.has(h.id)
      && Math.abs(Number(h.amount) - Number(c.amount)) <= 0.01
      && h.paymentDate.getTime() >= from - 86_400_000 && h.paymentDate.getTime() <= confirmedBy);
    if (!twin) continue;
    claimed.add(twin.id);
    await db.payment.delete({ where: { id: c.id } });
    dropped++;
  }
  return dropped;
}
