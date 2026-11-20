/**
 * A fee a provider adds to a bill left unpaid after it went out, carried into the next bill's
 * previous balance without a line of its own.
 *
 * City of Imperial (made-up figures): an Oct 1 bill asks $500.00 by Oct 15 and is not paid; the
 * Nov 1 bill reads "Previous balance $550.00 · Payment received $0.00". Nothing on either bill says
 * "late fee", but the $50.00 between them (10% of the bill) is one. Sollux read both bills right
 * and never saw it.
 *
 * The rule, which holds for every bill: the next bill's previous balance, before the payments it
 * shows, is what the last bill asked for. Anything more was charged after the last bill went out.
 * It goes on the bill that was paid late (as a late fee logged with a payment does, services/
 * lateFees.ts), so the bill's charge, its fees and the next bill's carried balance agree.
 *
 * Only when the two bills say enough to be sure: the last bill's printed total, the next bill's
 * carried balance and the payments it shows (or none logged in between), a month or so apart, no
 * payment plan, solar true-up or emailed figures in the way. Small differences (cents of rounding)
 * are not fees; a difference too large for a fee is reported, not recorded.
 */
export const CARRIED_FEE_LINE = 'Late fee (added to the next bill)';

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface BillFacts {
  statementDate: Date;
  /** What the bill asked to be paid now, as printed (its total amount due). */
  total: number | null;
  /** What it carried in from earlier bills, after the payments it shows. */
  carried: number | null;
  /** Payments the bill shows as received since the bill before; null when it shows none. */
  paymentsShown: number | null;
  /** A late fee the bill itself lists (its own, from the document). */
  ownFee: number;
  /** A payment plan, solar true-up or figures from an email: the balance moves for other reasons. */
  unsure: boolean;
}

export type CarriedFeeResult =
  | { kind: 'fee'; fee: number; difference: number }
  | { kind: 'none'; why: string }
  | { kind: 'unexplained'; difference: number; why: string };

/**
 * The fee charged between bill `a` and the next bill `b`.
 * `loggedOnA`: fees the owner already logged against `a` with a payment (not counted twice);
 * `paidBetween`: payments logged in Sollux between the two bills, used only when `b` shows none.
 */
export function carriedFeeBetween(a: BillFacts, b: BillFacts, loggedOnA = 0, paidBetween = 0): CarriedFeeResult {
  const days = (b.statementDate.getTime() - a.statementDate.getTime()) / DAY;
  if (days < 14 || days > 75) return { kind: 'none', why: 'not consecutive bills' };
  if (a.unsure || b.unsure) return { kind: 'none', why: 'payment plan, true-up or emailed figures' };
  if (a.total == null || b.carried == null) return { kind: 'none', why: 'figures missing' };
  let paid = b.paymentsShown;
  if (paid == null) {
    if (paidBetween > 0.005) return { kind: 'none', why: 'the next bill does not show the payments made' };
    paid = 0;
  }
  const difference = r2(b.carried + paid - a.total);
  // Listed on the next bill as its own late fee: already counted there.
  if (b.ownFee > 0.005 && Math.abs(difference - b.ownFee) < 0.05) return { kind: 'none', why: 'listed on the next bill' };
  const fee = r2(difference - loggedOnA);
  if (fee < 0.5) return { kind: 'none', why: difference < -0.5 ? 'a credit or adjustment' : 'no difference' };
  if (fee > Math.max(0.5 * Math.abs(a.total), 150)) return { kind: 'unexplained', difference, why: 'too large for a fee — a deposit, a correction or a missing bill' };
  return { kind: 'fee', fee, difference };
}
