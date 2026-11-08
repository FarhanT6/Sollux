/**
 * Credits toward rent: rent satisfied without money changing hands. What a
 * credit was for decides how it is booked:
 *
 * - The tenant paid something that was the owner's to pay (a repair, materials,
 *   a utility bill, yard work): rent income and an expense of the same amount
 *   (the IRS treats it so), recorded on the property with the credit.
 * - A security deposit applied to rent: rent income then.
 * - A concession or discount, or an earlier overpayment already counted when
 *   it came in: not income; it only settles what the tenant owes.
 */
import type { ExpenseCategory } from '@prisma/client';

export const CREDIT_REASONS = ['REPAIR', 'MATERIALS', 'UTILITY_BILL', 'YARD_WORK', 'OTHER_EXPENSE', 'DEPOSIT', 'CONCESSION', 'OVERPAYMENT', 'OTHER'] as const;
export type CreditReason = typeof CREDIT_REASONS[number];

export const CREDIT_REASON: Record<CreditReason, { label: string; expense: ExpenseCategory | null; income: boolean }> = {
  REPAIR: { label: 'Repair the tenant paid for', expense: 'REPAIRS_MAINTENANCE', income: true },
  MATERIALS: { label: 'Materials / supplies the tenant bought', expense: 'SUPPLIES', income: true },
  UTILITY_BILL: { label: 'A utility bill the tenant paid', expense: 'UTILITIES', income: true },
  YARD_WORK: { label: 'Yard work / landscaping', expense: 'LANDSCAPING', income: true },
  OTHER_EXPENSE: { label: 'Another property cost the tenant paid', expense: 'OTHER', income: true },
  DEPOSIT: { label: 'Security deposit applied to rent', expense: null, income: true },
  CONCESSION: { label: 'Concession / discount (move-in special, goodwill)', expense: null, income: false },
  OVERPAYMENT: { label: 'Earlier overpayment carried forward', expense: null, income: false },
  OTHER: { label: 'Other', expense: null, income: false },
};

/** Payments that are rent income (everything but a concession or carried overpayment). */
export const isRentIncome = { notIncome: false };
