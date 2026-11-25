/**
 * A loan's statement keeps its loan current. The account a lender bills is linked to its loan
 * (loans.utilityAccountId); a statement read with the loan's own figures (ExtractedBillData
 * .loanStatement: balance after the period, rate, regular payment, due date) puts them on that
 * loan, so the loan stops reading "Balance/rate unknown — confirm from a statement" while its
 * statements sit on file. The balance is taken only from the newest statement; an older one read
 * again leaves it. An account billed for a loan with no loan yet (category LOAN, or a statement
 * that gives the balance, the rate and the payment) gets one, personal when the account is —
 * unless the owner's loans already hold it (a mortgage on the Loans tab, its last 4 or its lender
 * and payment): that loan takes the figures, unlinked, instead of a second loan being made.
 *
 * The statement's payments, as the lender applied them (principal, interest, escrow on a
 * mortgage, fees, the balance after), go onto the loan's matching payments (same amount within
 * $1, within 5 days), so its payment history stops reading "—". A loan billed through an account,
 * whose payments live on that account, shows them from its statements (statementPaymentsOf).
 */
import { db } from '../config/db';
import { Prisma } from '@prisma/client';
import type { ExtractedBillData } from './pdfImportService';
import { sameCompany } from './billedLoans';

type StatementPayment = NonNullable<NonNullable<ExtractedBillData['loanStatement']>['payments']>[number];
const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const asNum = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

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
  const loan = await db.loan.findUnique({ where: { utilityAccountId }, select: { id: true, accountLast4: true, notes: true, escrowAmount: true } })
    ?? await heldElsewhere(account.property.userId, account.providerName, last4, ls.regularPayment);
  if (loan) {
    // A mortgage's escrow part, from the newest payment that shows one, when the loan has none.
    const escrow = [...(ls.payments ?? [])].reverse().find(p => (p.escrow ?? 0) > 0)?.escrow ?? null;
    await db.loan.update({
      where: { id: loan.id },
      data: {
        ...figures,
        ...(!loan.accountLast4 && last4 ? { accountLast4: last4 } : {}),
        ...(!loan.notes && ls.description ? { notes: ls.description } : {}),
        ...(loan.escrowAmount == null && escrow ? { escrowAmount: escrow } : {}),
      },
    });
    await splitPayments(loan.id, ls.payments ?? []);
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

/**
 * A loan the owner already has for the statement's debt, not billed through an account: the same
 * last 4, or the same lender and the same payment. A mortgage statement filed to an account made
 * a second mortgage; now it updates the one on the Loans tab (left unlinked — its payments stay
 * where they are counted).
 */
async function heldElsewhere(userId: string, lender: string, last4: string | null, payment: number | null) {
  const loans = await db.loan.findMany({
    where: { userId, isActive: true, utilityAccountId: null },
    select: { id: true, lender: true, accountLast4: true, notes: true, escrowAmount: true, monthlyPayment: true },
  });
  const byLast4 = last4 ? loans.filter(l => l.accountLast4 === last4) : [];
  if (byLast4.length === 1) return byLast4[0]!;
  const byLender = loans.filter(l => sameCompany(l.lender, lender) && payment != null && l.monthlyPayment != null && Math.abs(Number(l.monthlyPayment) - payment) <= 1);
  return byLender.length === 1 ? byLender[0]! : null;
}

/** The statement's split of each payment onto the loan's own payment of that amount (within $1, 5 days). */
export async function splitPayments(loanId: string, payments: StatementPayment[]): Promise<number> {
  const split = payments.filter(p => p.amount > 0 && (p.principal != null || p.interest != null || p.escrow != null));
  if (!split.length) return 0;
  const dates = split.map(p => Date.parse(`${p.date}T00:00:00Z`)).filter(Number.isFinite);
  const rows = await db.loanPayment.findMany({
    where: { loanId, date: { gte: new Date(Math.min(...dates) - 6 * DAY), lte: new Date(Math.max(...dates) + 6 * DAY) } },
    select: { id: true, date: true, amount: true, principal: true, interest: true, escrow: true, lateFee: true, balanceAfter: true },
  });
  const taken = new Set<string>();
  let changed = 0;
  for (const p of split) {
    const at = Date.parse(`${p.date}T00:00:00Z`);
    const row = rows
      .filter(r => !taken.has(r.id) && Math.abs(Number(r.amount) - p.amount) <= 1 && Math.abs(r.date.getTime() - at) <= 5 * DAY)
      .sort((a, b) => Math.abs(a.date.getTime() - at) - Math.abs(b.date.getTime() - at))[0];
    if (!row) continue;
    taken.add(row.id);
    const data: Prisma.LoanPaymentUpdateInput = {
      ...(p.principal != null && row.principal == null ? { principal: r2(p.principal) } : {}),
      ...(p.interest != null && row.interest == null ? { interest: r2(p.interest) } : {}),
      ...(p.escrow != null && p.escrow > 0 && row.escrow == null ? { escrow: r2(p.escrow) } : {}),
      ...(p.fees != null && p.fees > 0 && row.lateFee == null ? { lateFee: r2(p.fees) } : {}),
      ...(p.balance != null && row.balanceAfter == null ? { balanceAfter: r2(p.balance) } : {}),
    };
    if (!Object.keys(data).length) continue;
    await db.loanPayment.update({ where: { id: row.id }, data });
    changed++;
  }
  return changed;
}

export interface StatementLoanPayment { date: string; amount: number; principal: number | null; interest: number | null; escrow: number | null; fees: number | null; balance: number | null; statementDate: string }

/**
 * A loan billed through an account keeps its payments on that account, with no split; its
 * statements print the split. Every payment its statements list, once each (a statement reprints
 * the one before's), newest first, with the interest paid this year from the newest statement.
 */
export async function statementPaymentsOf(utilityAccountId: string): Promise<{ payments: StatementLoanPayment[]; ytdInterest: number | null; ytdAsOf: string | null }> {
  const statements = await db.statement.findMany({
    where: { utilityAccountId, isDownPayment: false },
    orderBy: { statementDate: 'desc' }, select: { statementDate: true, rawDataJson: true },
  });
  const seen = new Set<string>();
  const payments: StatementLoanPayment[] = [];
  let ytdInterest: number | null = null, ytdAsOf: string | null = null;
  for (const s of statements) {
    const ls = ((s.rawDataJson ?? {}) as Record<string, any>).loanStatement;
    if (!ls) continue;
    const when = s.statementDate.toISOString().slice(0, 10);
    if (ytdAsOf == null && asNum(ls.ytdInterest) != null) { ytdInterest = asNum(ls.ytdInterest); ytdAsOf = when; }
    for (const p of Array.isArray(ls.payments) ? ls.payments : []) {
      const amount = asNum(p?.amount);
      if (!p?.date || amount == null || amount <= 0) continue;
      const key = `${String(p.date).slice(0, 10)}|${amount.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      payments.push({ date: String(p.date).slice(0, 10), amount, principal: asNum(p.principal), interest: asNum(p.interest), escrow: asNum(p.escrow), fees: asNum(p.fees), balance: asNum(p.balance), statementDate: when });
    }
  }
  payments.sort((a, b) => b.date.localeCompare(a.date));
  return { payments, ytdInterest, ytdAsOf };
}
