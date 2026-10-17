/**
 * How long an account can go without a new bill before that is a problem:
 * its billing cycle plus some slack for a late statement. Null for cadences
 * where silence is normal (annual, per term, one-time). One rule for the
 * Gmail coverage report and the portal sync, so they never disagree.
 */
export function overdueAfterDays(cadence: string | null | undefined): number | null {
  return cadence === 'BIMONTHLY' ? 75 : cadence === 'QUARTERLY' ? 110 : cadence === 'MONTHLY' ? 45 : null;
}
