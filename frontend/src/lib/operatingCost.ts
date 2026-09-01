/**
 * What a bill says the property cost to run, as against what it says to pay.
 * Mirrors backend/src/services/operatingCost.ts — the stat cards are computed
 * in the browser, so the rule has to exist on both sides and agree.
 *
 * A City of Brawley bill reads Water 191.35 + Sewer 176.03 + Payment Plan
 * 81.36 + Tax 14.69, plus $42.32 penalties. Only the service lines are the
 * cost of running the property this month; the installment repays an older
 * debt and the penalty is the price of paying late. Counting them inflates
 * operating cost for as long as the arrears plan runs, then shows a false
 * improvement when it ends.
 */

export interface OperatingCostOptions {
  includePenalties?: boolean;
  includePaymentPlan?: boolean;
}

export interface BillAmounts {
  amountDue?: number | string | null;
  penaltiesFees?: number | string | null;
  paymentPlanAmount?: number | string | null;
}

const num = (v: number | string | null | undefined): number =>
  v == null || Number.isNaN(Number(v)) ? 0 : Number(v);

export function operatingCost(bill: BillAmounts, opts: OperatingCostOptions = {}): number {
  let total = num(bill.amountDue);
  if (!opts.includePenalties) total -= num(bill.penaltiesFees);
  if (!opts.includePaymentPlan) total -= num(bill.paymentPlanAmount);
  // A bill made entirely of penalties and arrears costs nothing to run.
  return Math.max(0, total);
}

export function excludedFromOperating(bill: BillAmounts, opts: OperatingCostOptions = {}) {
  const penalties = opts.includePenalties ? 0 : num(bill.penaltiesFees);
  const paymentPlan = opts.includePaymentPlan ? 0 : num(bill.paymentPlanAmount);
  return { penalties, paymentPlan, total: penalties + paymentPlan };
}
