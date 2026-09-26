import type { LoanPaymentMethod } from '../types';

export const PAYMENT_METHOD_LABELS: Record<LoanPaymentMethod, string> = {
  AUTOPAY: 'Autopay (taken out of your account)',
  ONLINE: 'Pay online',
  CHECK: 'Check by mail',
  ZELLE: 'Zelle',
  BANK_DEPOSIT: "Deposit into the lender's account",
  CASH: 'Cash',
  WIRE: 'Wire',
  DEDUCTED: 'Deducted by a broker / servicer',
  OTHER: 'Other',
};
export const PAYMENT_METHODS = Object.keys(PAYMENT_METHOD_LABELS) as LoanPaymentMethod[];

/** Short form for tables: "Check · Zelle". */
export const methodsShort = (m: string[] | undefined) =>
  (m ?? []).map(x => ({ AUTOPAY: 'Autopay', ONLINE: 'Online', CHECK: 'Check', ZELLE: 'Zelle', BANK_DEPOSIT: 'Deposit', CASH: 'Cash', WIRE: 'Wire', DEDUCTED: 'Deducted', OTHER: 'Other' } as Record<string, string>)[x] ?? x).join(' · ');
