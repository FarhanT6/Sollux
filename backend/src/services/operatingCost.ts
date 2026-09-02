/**
 * What a bill says the property cost to run, as distinct from what it says to pay.
 *
 * A City of Brawley water bill for 432 W D St reads:
 *
 *     Water        191.35
 *     Sewer        176.03
 *     Payment Plan  81.36
 *     Tax           14.69
 *     CURRENT BILL 463.43   (plus $42.32 penalties)
 *
 * Only $382.07 of that is water service this month. The $81.36 is repayment of
 * an older debt and the penalties are the price of paying late — both real cash
 * leaving the account, neither the cost of running the property. Averaging the
 * $463.43 into a monthly figure overstates operating cost for as long as the
 * arrears plan runs, and then appears to show a sudden improvement when it ends.
 *
 * Two numbers, not one:
 *   - operating cost, for "what does this property cost to run"
 *   - total billed, for "what has to be paid"
 *
 * Which one feeds the headline figures is the owner's call, so both exclusions
 * are settings rather than a rule imposed here.
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

/**
 * The cost of running the property for this bill's period.
 *
 * Starts from the period's charge and removes what is not service, according
 * to the settings. Never returns less than zero: a bill made up entirely of
 * penalties and arrears has an operating cost of nothing, not a negative.
 */
export function operatingCost(bill: BillAmounts, opts: OperatingCostOptions = {}): number {
  let total = num(bill.amountDue);
  if (!opts.includePenalties) total -= num(bill.penaltiesFees);
  if (!opts.includePaymentPlan) total -= num(bill.paymentPlanAmount);
  return Math.max(0, total);
}

/** Everything the bill asks for, whatever it is made of. */
export function totalBilled(bill: BillAmounts): number {
  return num(bill.amountDue);
}

/** What was excluded, so a figure can explain the difference rather than just differ. */
export function excludedFromOperating(
  bill: BillAmounts,
  opts: OperatingCostOptions = {},
): { penalties: number; paymentPlan: number; total: number } {
  const penalties = opts.includePenalties ? 0 : num(bill.penaltiesFees);
  const paymentPlan = opts.includePaymentPlan ? 0 : num(bill.paymentPlanAmount);
  return { penalties, paymentPlan, total: penalties + paymentPlan };
}
