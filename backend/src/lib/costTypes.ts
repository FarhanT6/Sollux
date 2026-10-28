/**
 * The pure half of the cost ledger (lib/costLedger.ts): the cost types, how
 * an account or a logged expense is classified, and the month arithmetic.
 * Kept apart so tests can load it without a database.
 */
export type CostType = 'UTILITIES' | 'INSURANCE' | 'PROPERTY_TAX' | 'HOA' | 'MAINTENANCE' | 'MANAGEMENT' | 'OTHER' | 'DEBT_SERVICE' | 'CAPITAL';
export const OPERATING: CostType[] = ['UTILITIES', 'INSURANCE', 'PROPERTY_TAX', 'HOA', 'MAINTENANCE', 'MANAGEMENT', 'OTHER'];

export interface MonthFigure { charged: number; paid: number }
export interface LedgerItem { date: string; label: string; charged: number; paid: number; statementId?: string; expenseId?: string }
export interface LedgerLine {
  key: string;
  type: CostType;
  source: 'account' | 'expense' | 'loan' | 'tax' | 'policy';
  propertyId: string;
  label: string;
  sub: string | null;
  /** Where to go for the detail: the account, the loan, the Taxes or Insurance page. */
  link: string | null;
  months: Record<string, MonthFigure>;
  /** Logged expenses, one by one, so they can be edited. */
  items?: LedgerItem[];
}

// Insurance billed on an account filed as something else: premium finance
// companies bill like lenders, and a carrier sometimes lands under Other.
const INSURANCE_NAME = /insurance|premium financ|fair plan|assurance|indemnity|underwriter|casualty|mutual/i;

export function typeOfAccount(category: string, providerName: string): CostType | null {
  if (category === 'INSURANCE' || INSURANCE_NAME.test(providerName)) return 'INSURANCE';
  switch (category) {
    case 'ELECTRIC': case 'GAS': case 'WATER': case 'SEWER': case 'TRASH': case 'SOLAR': case 'INTERNET': case 'PHONE': return 'UTILITIES';
    case 'HOA': return 'HOA';
    case 'TAXES': return 'PROPERTY_TAX';
    case 'LOAN': return 'DEBT_SERVICE';
    case 'CREDIT_CARD': return null;
    default: return 'OTHER';
  }
}

export function typeOfExpense(category: string, isCapEx: boolean): CostType {
  if (isCapEx || category === 'CAPITAL_IMPROVEMENT') return 'CAPITAL';
  switch (category) {
    case 'UTILITIES': return 'UTILITIES';
    case 'INSURANCE': return 'INSURANCE';
    case 'PROPERTY_TAX': return 'PROPERTY_TAX';
    case 'HOA': return 'HOA';
    case 'MORTGAGE_DEBT_SERVICE': return 'DEBT_SERVICE';
    case 'PROPERTY_MANAGEMENT': return 'MANAGEMENT';
    case 'REPAIRS_MAINTENANCE': case 'HANDYMAN': case 'LANDSCAPING': case 'SUPPLIES': return 'MAINTENANCE';
    default: return 'OTHER';
  }
}

export const ym = (d: Date) => d.toISOString().slice(0, 7);
export const n = (v: unknown) => (v == null ? 0 : Number(v));
export const r2 = (x: number) => Math.round(x * 100) / 100;

/** The months from..to inclusive, as YYYY-MM. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

/** A bill's operating charge: its own period, less a true-up deferral and a payment-plan installment (old debt, not this month's cost). */
export function operatingCharge(s: { amountDue: unknown; trueUpDeferred: unknown; paymentPlanAmount: unknown }): number {
  return r2(n(s.amountDue) - n(s.trueUpDeferred) - n(s.paymentPlanAmount));
}

