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
export const onLoansTab = (l: { loanType: string; utilityAccountId?: string | null; propertyId?: string | null }) =>
  isPropertyLoan(l) && !l.utilityAccountId;

/** A mortgage or private note — or a loan typed Other that sits on a property, which is a property loan too
 *  (a note to a seller or relative saved as Other was left out of Loans and of Mark mortgages paid to date). */
export const isPropertyLoan = (l: { loanType: string; propertyId?: string | null; property?: string | null }) =>
  MORTGAGE_PERSONAL_TYPES.includes(l.loanType as LoanType) || (l.loanType === 'OTHER' && !!(l.propertyId || l.property));
