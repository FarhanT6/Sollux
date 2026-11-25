/**
 * A loan's statement keeps its loan current. The account a lender bills is linked to its loan
 * (loans.utilityAccountId); a statement read with the loan's own figures (ExtractedBillData
 * .loanStatement: balance after the period, rate, regular payment, due date) puts them on that
 * loan, so the loan stops reading "Balance/rate unknown — confirm from a statement" while its
 * statements sit on file. The balance is taken only from the newest statement; an older one read
 * again leaves it. An account billed for a loan with no loan yet (category LOAN, or a statement
 * that gives the balance, the rate and the payment) gets one, personal when the account is.
 */
import { db } from '../config/db';
import type { ExtractedBillData } from './pdfImportService';

const VEHICLE = /\b(?:auto|vehicle|car|truck|suv|motorcycle|rv|boat|jeep|ford|toyota|honda|chevrolet|chevy|nissan|tesla|bmw|mercedes|audi|lexus|kia|hyundai|subaru|mazda|dodge|ram|gmc|volkswagen|vw)\b/i;

/** What kind of loan a statement's description says it is. */
export function loanTypeOf(description: string | null | undefined, lender: string): 'AUTO' | 'MORTGAGE' | 'HELOC' | 'STUDENT' | 'PERSONAL' {
  const d = `${description ?? ''} ${lender}`;
  if (/heloc|home\s+equity/i.test(d)) return 'HELOC';
  if (/mortgage|escrow|home\s+loan/i.test(d)) return 'MORTGAGE';
  if (/student|education|direct\s+(?:sub|unsub)/i.test(d)) return 'STUDENT';
  if (VEHICLE.test(d) || /\b(?:19|20)\d{2}\s+[A-Z][a-z]+/.test(description ?? '')) return 'AUTO';
  return 'PERSONAL';
}

export async function syncLoanFromStatement(utilityAccountId: string, ex: ExtractedBillData): Promise<'updated' | 'created' | null> {
  const ls = ex.loanStatement;
  if (!ls) return null;
  const account = await db.utilityAccount.findUnique({
    where: { id: utilityAccountId },
    select: { id: true, propertyId: true, providerName: true, category: true, isPersonal: true, memberId: true, isActive: true, accountNumber: true, property: { select: { userId: true } } },
  });
  if (!account) return null;
  const billDate = ex.statementDate ? new Date(`${ex.statementDate.slice(0, 10)}T00:00:00Z`) : null;
  const newer = billDate
    ? await db.statement.findFirst({ where: { utilityAccountId, isDownPayment: false, statementDate: { gt: billDate } }, select: { id: true } })
    : null;
  const last4 = String(ex.accountNumber ?? account.accountNumber ?? '').replace(/\D/g, '').slice(-4) || null;
  const figures = {
    ...(ls.apr != null && ls.apr > 0 && ls.apr < 40 ? { interestRate: ls.apr } : {}),
    ...(ls.regularPayment != null && ls.regularPayment > 0 ? { monthlyPayment: ls.regularPayment } : {}),
    ...(ls.dueDate ? { dueDay: Number(ls.dueDate.slice(8, 10)) } : {}),
    ...(!newer && ls.endingBalance != null && ls.endingBalance >= 0 ? { currentBalance: ls.endingBalance } : {}),
  };
  const loan = await db.loan.findUnique({ where: { utilityAccountId }, select: { id: true, accountLast4: true, notes: true } });
  if (loan) {
    await db.loan.update({
      where: { id: loan.id },
      data: {
        ...figures,
        ...(!loan.accountLast4 && last4 ? { accountLast4: last4 } : {}),
        ...(!loan.notes && ls.description ? { notes: ls.description } : {}),
      },
    });
    return 'updated';
  }
  const sure = account.category === 'LOAN' || (ls.endingBalance != null && ls.apr != null && ls.regularPayment != null);
  if (!sure) return null;
  await db.loan.create({
    data: {
      userId: account.property.userId,
      propertyId: account.isPersonal ? null : account.propertyId,
      utilityAccountId,
      lender: account.providerName,
      loanType: loanTypeOf(ls.description, account.providerName),
      isPersonal: account.isPersonal,
      memberId: account.isPersonal ? account.memberId : null,
      isActive: account.isActive,
      ...(last4 ? { accountLast4: last4 } : {}),
      ...(ls.description ? { notes: ls.description } : {}),
      ...figures,
      // An older statement first: its balance stands until a newer one comes.
      ...(figures.currentBalance == null && ls.endingBalance != null ? { currentBalance: ls.endingBalance } : {}),
    },
  });
  return 'created';
}
