/**
 * What one month of an account actually costs.
 *
 * A property's "monthly spend" used to sum the latest statement balance of
 * every account, which is right only when every account bills monthly. An
 * annual insurance premium of $2,040 counted as $2,040 in the month its bill
 * landed and $0 in the other eleven — the figure was wrong every month of the
 * year, and wrong by a different amount each time.
 *
 * The cadence lives on the account, so this is the one place that converts.
 */

export type Cadence =
  | 'MONTHLY' | 'BIMONTHLY' | 'QUARTERLY' | 'SEMI_ANNUAL' | 'ANNUAL'
  | 'TERM' | 'ONE_TIME' | 'IRREGULAR';

/** How many months one bill on this cadence covers. */
export function monthsCovered(cadence: Cadence, termMonths?: number | null): number {
  switch (cadence) {
    case 'MONTHLY': return 1;
    case 'BIMONTHLY': return 2;
    case 'QUARTERLY': return 3;
    case 'SEMI_ANNUAL': return 6;
    case 'ANNUAL': return 12;
    // A term with no length recorded is treated as a year — the common case,
    // and better than dividing by nothing.
    case 'TERM': return termMonths && termMonths > 0 ? termMonths : 12;
    // A one-off is not a recurring cost at all; callers use monthlyEquivalent,
    // which returns 0 for it, rather than dividing by this.
    case 'ONE_TIME': return 1;
    case 'IRREGULAR': return 1;
  }
}

export interface CadenceAccount {
  billingCadence?: Cadence | null;
  termMonths?: number | null;
  expectedAmount?: number | string | null;
}

/**
 * The monthly-equivalent cost of an account.
 *
 * `billAmount` is the amount of one bill — normally the latest statement's
 * charge. Falls back to the account's expectedAmount when no statement has
 * been imported yet, which is what makes a newly added annual policy show a
 * sensible monthly figure straight away.
 *
 * Returns 0 for ONE_TIME: a premium paid up front is a real cost, but it is
 * not part of any month's recurring spend, and averaging it across a year
 * would imply a renewal that isn't coming.
 */
export function monthlyEquivalent(account: CadenceAccount, billAmount?: number | null): number {
  const cadence = (account.billingCadence ?? 'MONTHLY') as Cadence;
  if (cadence === 'ONE_TIME') return 0;

  const amount = billAmount != null && !Number.isNaN(Number(billAmount))
    ? Number(billAmount)
    : Number(account.expectedAmount ?? 0);
  if (!amount) return 0;

  return amount / monthsCovered(cadence, account.termMonths);
}

/**
 * Does this account bill every month?
 *
 * Used wherever a missing recent statement would otherwise read as a problem:
 * an annual policy with nothing since March is not overdue in July.
 */
export function billsMonthly(account: CadenceAccount): boolean {
  const cadence = (account.billingCadence ?? 'MONTHLY') as Cadence;
  return cadence === 'MONTHLY' || cadence === 'IRREGULAR';
}
