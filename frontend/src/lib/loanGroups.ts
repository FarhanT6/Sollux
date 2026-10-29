import type { LoanType } from '../types';

// Real-estate-secured debt (and personal loans, which usually ride along
// with the same lenders) vs. consumer-style installment debt — kept
// separate since they behave very differently in a portfolio's debt
// picture.
export const MORTGAGE_PERSONAL_TYPES: LoanType[] = ['MORTGAGE', 'HELOC', 'SELLER_FINANCING', 'DSCR', 'COMMERCIAL', 'HARD_MONEY', 'PERSONAL'];

/** The Loans tab is mortgages and private notes. Consumer loans and loans
 *  billed through a utility account (premium financing, solar) live on their
 *  accounts and the Bills page, where their bills and payments are; a second
 *  copy here disagreed with them. */
export const onLoansTab = (l: { loanType: string; utilityAccountId?: string | null }) =>
  MORTGAGE_PERSONAL_TYPES.includes(l.loanType as LoanType) && !l.utilityAccountId;
