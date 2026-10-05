/**
 * One-time invoices that arrive with the bills: a plumber, a landscaper, an
 * attorney. They are not a utility, so they become an Expense on the property
 * (with the PDF), not a statement on a made-up utility account. Before this,
 * a Mauzy Plumbing invoice addressed to a property was matched as "property
 * exists, no account" and given a new utility account of its own.
 */
import { db } from '../config/db';
import { uploadDocument } from './s3Service';
import type { ExtractedBillData } from './pdfImportService';

export const EXPENSE_CATEGORIES = [
  'REPAIRS_MAINTENANCE', 'HANDYMAN', 'LANDSCAPING', 'LEGAL', 'PROPERTY_MANAGEMENT', 'CAPITAL_IMPROVEMENT',
  'SUPPLIES', 'PERMITS', 'CITATIONS_FINES', 'ADVERTISING', 'INSURANCE', 'HOA', 'PROPERTY_TAX', 'OTHER',
] as const;
export type IntakeExpenseCategory = typeof EXPENSE_CATEGORIES[number];

const sanitize = (s: string) => s.replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'invoice.pdf';

/** What the invoice charges: its stated total, else its amount due or charges. */
export function invoiceAmount(ex: ExtractedBillData): number | null {
  for (const v of [ex.statedTotalDue, ex.amountDue, ex.currentCharges]) if (typeof v === 'number' && v > 0) return v;
  return null;
}

export async function fileServiceInvoice(
  userId: string, propertyId: string | null, ex: ExtractedBillData, pdf: Buffer | null, filename: string,
  category?: string | null,
): Promise<{ expenseId: string; duplicate: boolean }> {
  const amount = invoiceAmount(ex);
  if (amount == null) throw new Error(`${filename}: the invoice shows no amount to record`);
  const date = new Date(`${(ex.statementDate ?? new Date().toISOString()).slice(0, 10)}T00:00:00Z`);
  const vendor = ex.providerName?.slice(0, 200) ?? null;
  const cat = (EXPENSE_CATEGORIES as readonly string[]).includes(category ?? '') ? category
    : (EXPENSE_CATEGORIES as readonly string[]).includes(ex.expenseCategory ?? '') ? ex.expenseCategory : 'REPAIRS_MAINTENANCE';

  // The same invoice read twice (two inboxes, a re-import) is one expense.
  const dup = await db.expense.findFirst({ where: { userId, vendor, amount, date }, select: { id: true } });
  if (dup) return { expenseId: dup.id, duplicate: true };

  let documentKey: string | null = null;
  if (pdf) {
    documentKey = `${userId}/expenses/${date.toISOString().slice(0, 10)}_${sanitize(filename)}`;
    await uploadDocument(documentKey, pdf);
  }
  const lines = ex.chargeBreakdown ? Object.keys(ex.chargeBreakdown).slice(0, 4).join('; ') : '';
  const expense = await db.expense.create({
    data: {
      userId, propertyId, isPersonal: !propertyId,
      category: cat as any, amount, date, vendor,
      description: [ex.accountNumber ? `Invoice ${ex.accountNumber}` : 'Invoice', lines, ex.dueDate ? `due ${ex.dueDate}` : ''].filter(Boolean).join(' — ').slice(0, 500),
      // The PDF's storage key; it is opened through a signed URL, never publicly.
      documentUrl: documentKey,
    },
  });
  return { expenseId: expense.id, duplicate: false };
}
