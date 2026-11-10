/**
 * What money in or spending in a cash, check or app wallet was for
 * (Finances → Income → Cash, checks & apps). Income kinds that are income make
 * an "other income" record (it counts in the budget); money that is not
 * income — a balance carried over, money moved from the owner's own account —
 * makes none. Spending for a property becomes that property's expense, under
 * the expense category given here.
 */
export interface WalletCategory {
  id: string;
  label: string;
  /** The other-income category it is recorded as; absent for money in that is not income. */
  otherIncome?: string;
  /** The property expense category it is recorded as, when a property is chosen. */
  expense?: string;
}

export const INCOME_CATEGORIES: WalletCategory[] = [
  { id: 'APPLIANCE_SERVICE', label: 'Appliance business — service call', otherIncome: 'APPLIANCE_SERVICE' },
  { id: 'APPLIANCE_DELIVERY', label: 'Appliance business — delivery', otherIncome: 'APPLIANCE_DELIVERY' },
  { id: 'APPLIANCE_SALE', label: 'Appliance business — sale', otherIncome: 'APPLIANCE_SALE' },
  { id: 'HANDYMAN_SERVICE', label: 'Handyman work for others', otherIncome: 'HANDYMAN_SERVICE' },
  { id: 'LAUNDRY', label: 'Laundry', otherIncome: 'LAUNDRY' },
  { id: 'GOVERNMENT_BENEFIT', label: 'Government benefit', otherIncome: 'GOVERNMENT_BENEFIT' },
  { id: 'LOAN_RECEIVED', label: 'Loan received', otherIncome: 'LOAN_RECEIVED' },
  { id: 'SECURITY_DEPOSIT', label: 'Security deposit collected', otherIncome: 'SECURITY_DEPOSIT' },
  { id: 'DEPOSIT_REFUND_IN', label: 'Deposit returned to me', otherIncome: 'DEPOSIT_REFUND_IN' },
  { id: 'INTERNATIONAL', label: 'Money from abroad', otherIncome: 'INTERNATIONAL' },
  { id: 'OTHER_INCOME', label: 'Other income', otherIncome: 'OTHER' },
  // Not income: no record is made.
  { id: 'CARRIED_OVER', label: 'Balance carried over (not income)' },
  { id: 'OWN_MONEY', label: 'From my own account (not income)' },
  { id: 'PAID_BACK', label: 'Paid back / reimbursed (not income)' },
];

export const SPEND_CATEGORIES: WalletCategory[] = [
  { id: 'HANDYMAN', label: 'Handyman / labor', expense: 'HANDYMAN' },
  { id: 'REPAIRS', label: 'Repairs & maintenance', expense: 'REPAIRS_MAINTENANCE' },
  { id: 'SUPPLIES', label: 'Materials & supplies', expense: 'SUPPLIES' },
  { id: 'LANDSCAPING', label: 'Landscaping', expense: 'LANDSCAPING' },
  { id: 'UTILITIES', label: 'Utilities', expense: 'UTILITIES' },
  { id: 'APPLIANCE_COSTS', label: 'Appliance business — parts & costs', expense: 'OTHER' },
  { id: 'HANDYMAN_JOB_COSTS', label: 'Handyman jobs for others — costs', expense: 'OTHER' },
  { id: 'PERSONAL', label: 'Personal' },
  { id: 'OTHER_SPENDING', label: 'Other', expense: 'OTHER' },
];

const BY_ID = new Map([...INCOME_CATEGORIES, ...SPEND_CATEGORIES].map(c => [c.id, c]));
export const walletCategory = (id: string | null | undefined) => (id ? BY_ID.get(id) ?? null : null);
/** A category that fits the movement: income kinds for money in, spending kinds for spending. */
export const fits = (type: string, id: string | null | undefined) =>
  !id || (type === 'OTHER_IN' ? INCOME_CATEGORIES : type === 'SPENT' ? SPEND_CATEGORIES : []).some(c => c.id === id);
