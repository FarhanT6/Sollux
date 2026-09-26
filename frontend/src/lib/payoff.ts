/**
 * Paying off credit cards with a fixed monthly budget. Every card gets its
 * minimum; whatever is left goes to one target card — the highest rate first
 * (avalanche: least interest) or the smallest balance first (snowball: the
 * quickest wins). When a card is paid off its payment rolls onto the next.
 * A promotional rate applies until its end date, then the purchase rate.
 */

export interface PayoffCard { id: string; name: string; balance: number; apr: number; promoApr?: number | null; promoEndsInMonths?: number | null; minimum: number }
export type Strategy = 'avalanche' | 'snowball';
export interface PayoffResult {
  months: number | null; // null: the budget never pays it off
  totalInterest: number;
  totalPaid: number;
  perCard: { id: string; name: string; paidOffMonth: number | null; interest: number }[];
  shortfall: number; // how far the budget is below the sum of minimums
}

export function simulatePayoff(cards: PayoffCard[], monthlyBudget: number, strategy: Strategy, maxMonths = 600): PayoffResult {
  const live = cards.filter(c => c.balance > 0.005).map(c => ({ ...c, bal: c.balance, interest: 0, paidOff: null as number | null }));
  const minimums = live.reduce((t, c) => t + Math.min(c.minimum, c.bal), 0);
  const shortfall = Math.max(0, Number((minimums - monthlyBudget).toFixed(2)));
  let totalInterest = 0, totalPaid = 0, month = 0;

  const rateOf = (c: typeof live[number], m: number) =>
    c.promoApr != null && c.promoEndsInMonths != null && m <= c.promoEndsInMonths ? c.promoApr : c.apr;

  while (live.some(c => c.bal > 0.005) && month < maxMonths) {
    month++;
    const before = live.reduce((t, c) => t + c.bal, 0);
    // Interest accrues on what is carried.
    for (const c of live) {
      if (c.bal <= 0.005) continue;
      const i = (c.bal * rateOf(c, month)) / 100 / 12;
      c.bal += i; c.interest += i; totalInterest += i;
    }
    let budget = monthlyBudget;
    // Minimums first.
    for (const c of live) {
      if (c.bal <= 0.005) continue;
      const pay = Math.min(c.bal, c.minimum, budget);
      c.bal -= pay; budget -= pay; totalPaid += pay;
    }
    // The rest goes to the target, then the next, until the budget is spent.
    const order = live.filter(c => c.bal > 0.005).sort((a, b) =>
      strategy === 'avalanche' ? rateOf(b, month) - rateOf(a, month) || a.bal - b.bal : a.bal - b.bal || rateOf(b, month) - rateOf(a, month));
    for (const c of order) {
      if (budget <= 0.005) break;
      const pay = Math.min(c.bal, budget);
      c.bal -= pay; budget -= pay; totalPaid += pay;
    }
    for (const c of live) if (c.bal <= 0.005 && c.paidOff == null) { c.bal = 0; c.paidOff = month; }
    // A budget that does not beat the interest never finishes.
    const after = live.reduce((t, c) => t + c.bal, 0);
    if (after > 0.005 && after >= before - 0.005) break;
  }
  const done = live.every(c => c.bal <= 0.005);
  return {
    months: done ? month : null,
    totalInterest: Number(totalInterest.toFixed(2)),
    totalPaid: Number(totalPaid.toFixed(2)),
    perCard: live.map(c => ({ id: c.id, name: c.name, paidOffMonth: c.paidOff, interest: Number(c.interest.toFixed(2)) })),
    shortfall,
  };
}
