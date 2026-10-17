/**
 * How long an account can go without a new bill before that is a problem:
 * its billing cycle plus some slack for a late statement. Null for cadences
 * where silence is normal (annual, per term, one-time). One rule for the
 * Gmail coverage report and the portal sync, so they never disagree.
 */
export function overdueAfterDays(cadence: string | null | undefined): number | null {
  return cadence === 'BIMONTHLY' ? 75 : cadence === 'QUARTERLY' ? 110 : cadence === 'MONTHLY' ? 45 : null;
}

/** Days between bills: when the next one is expected. Unknown or once-a-term cadences fall back to monthly checks. */
export function billCycleDays(cadence: string | null | undefined): number {
  return cadence === 'BIMONTHLY' ? 60 : cadence === 'QUARTERLY' ? 91 : cadence === 'SEMI_ANNUAL' ? 182 : cadence === 'ANNUAL' ? 365 : 30;
}
