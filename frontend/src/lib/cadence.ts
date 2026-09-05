/**
 * Billing cadence on the client — the mirror of backend/src/services/
 * billingCadence.ts. Kept in step with it: if one changes, both do.
 *
 * The totals on the properties list and a property's page are computed in the
 * browser from the accounts the API returns, so the conversion has to exist
 * here too. Without it an annual premium counts at full value in whichever
 * month its bill happens to sit.
 */

export type Cadence =
  | 'MONTHLY' | 'BIMONTHLY' | 'QUARTERLY' | 'SEMI_ANNUAL' | 'ANNUAL'
  | 'TERM' | 'ONE_TIME' | 'IRREGULAR';

export const CADENCE_LABELS: Record<Cadence, string> = {
  MONTHLY: 'Monthly',
  BIMONTHLY: 'Every 2 months',
  QUARTERLY: 'Every 3 months',
  SEMI_ANNUAL: 'Every 6 months',
  ANNUAL: 'Once a year',
  TERM: 'Once per policy term',
  ONE_TIME: 'One time only (paid up front)',
  IRREGULAR: 'No set schedule',
};

export function monthsCovered(cadence: Cadence, termMonths?: number | null): number {
  switch (cadence) {
    case 'BIMONTHLY': return 2;
    case 'QUARTERLY': return 3;
    case 'SEMI_ANNUAL': return 6;
    case 'ANNUAL': return 12;
    case 'TERM': return termMonths && termMonths > 0 ? termMonths : 12;
    default: return 1;
  }
}

export interface CadenceAccount {
  billingCadence?: Cadence | null;
  termMonths?: number | null;
  expectedAmount?: number | string | null;
}

/**
 * What one month of this account costs, given the amount of one bill.
 *
 * Returns 0 for ONE_TIME — a premium paid up front is a real cost but not part
 * of any month's recurring spend, and spreading it would imply a renewal that
 * isn't coming.
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

/** "$2,040.00 a year — $170.00 a month" for the form to show while typing. */
export function describeCadenceAmount(
  cadence: Cadence,
  amount: number,
  termMonths?: number | null,
): string | null {
  if (!amount || cadence === 'MONTHLY') return null;
  const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (cadence === 'ONE_TIME') {
    return `${money(amount)} once — not counted in monthly spend.`;
  }
  const months = monthsCovered(cadence, termMonths);
  return `${money(amount)} per bill — about ${money(amount / months)} a month.`;
}
