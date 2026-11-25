/**
 * One account checked against its own PDFs, now, with the free readers (no model): the bills
 * those readers take are put right (services/textRecheck.ts), email bills saved as their whole
 * total are split (services/emailTotals.ts), late fees folded into the next bill are worked out
 * again (services/carriedFees.ts), and a loan statement brings the account's loan up to date
 * (services/loanStatements.ts). It says what it did to each bill and what it left — a bill the
 * owner edited by hand is left unless they ask for the PDF's figures — so nothing is a mystery.
 */
import { db } from '../config/db';
import { recheckStoredStatements, type RecheckLine } from './textRecheck';
import { repairEmailTotals } from './emailTotals';
import { settleCarriedFees } from './carriedFees';
import { syncLoanFromStatement } from './loanStatements';
import { reconcileRecent } from './billIdentity';
import type { ExtractedBillData } from './pdfImportService';

const r2 = (n: number) => Math.round(n * 100) / 100;

async function carriedTotal(utilityAccountId: string): Promise<number> {
  const a = await db.statement.aggregate({ where: { utilityAccountId }, _sum: { carriedFee: true } });
  return r2(Number(a._sum.carriedFee ?? 0));
}

export interface AccountRecheck {
  lines: RecheckLine[];
  fixed: number;
  ownerEdited: number;
  notRead: number;
  emailSplit: number;
  feesRemoved: number;
  loan: { balance: number | null; rate: number | null; payment: number | null; dueDay: number | null } | { none: string } | null;
}

export async function recheckAccount(userId: string, utilityAccountId: string, opts: { includeOwnerEdited?: boolean; textOf?: (pdfKey: string) => Promise<string>; recentDays?: number } = {}): Promise<AccountRecheck | null> {
  const acct = await db.utilityAccount.findFirst({ where: { id: utilityAccountId, property: { userId } }, select: { id: true } });
  if (!acct) return null;
  const feesBefore = await carriedTotal(utilityAccountId);
  const r = await recheckStoredStatements({ accountIds: [utilityAccountId], includeOwnerEdited: !!opts.includeOwnerEdited, textOf: opts.textOf, recentDays: opts.recentDays });
  // The newest bills' own arithmetic too (#278), before the late-fee check below.
  await reconcileRecent(utilityAccountId).catch(() => null);
  const emailSplit = await repairEmailTotals([utilityAccountId]);
  await settleCarriedFees(utilityAccountId).catch(() => null);
  const feesAfter = await carriedTotal(utilityAccountId);

  // The loan: from the newest statement that read as a loan statement.
  let loan: AccountRecheck['loan'] = null;
  const linked = await db.loan.findUnique({ where: { utilityAccountId }, select: { id: true } });
  const rows = await db.statement.findMany({ where: { utilityAccountId, isDownPayment: false }, orderBy: { statementDate: 'desc' }, select: { statementDate: true, rawDataJson: true }, take: 24 });
  const newest = rows.find(s => (s.rawDataJson as Record<string, unknown> | null)?.loanStatement);
  if (newest) {
    const ex = { loanStatement: (newest.rawDataJson as any).loanStatement, statementDate: newest.statementDate.toISOString().slice(0, 10) } as ExtractedBillData;
    await syncLoanFromStatement(utilityAccountId, ex);
  }
  const after = await db.loan.findUnique({ where: { utilityAccountId }, select: { currentBalance: true, interestRate: true, monthlyPayment: true, dueDay: true } });
  if (after) {
    loan = newest
      ? { balance: after.currentBalance != null ? Number(after.currentBalance) : null, rate: after.interestRate != null ? Number(after.interestRate) : null, payment: after.monthlyPayment != null ? Number(after.monthlyPayment) : null, dueDay: after.dueDay }
      : { none: "None of the statements on file read as a loan statement, so the loan's balance and rate were left as they are." };
  } else if (linked == null && newest) {
    loan = { none: 'No loan could be made from the statements.' };
  }

  return {
    lines: r.lines.sort((a, b) => b.statementDate.localeCompare(a.statementDate)),
    fixed: r.fixed,
    ownerEdited: r.lines.filter(l => l.outcome === 'owner-edited').length,
    notRead: r.lines.filter(l => l.outcome === 'not-read').length,
    emailSplit,
    feesRemoved: r2(feesBefore - feesAfter),
    loan,
  };
}

/**
 * Every night: each active account with a bill in the last 75 days checked the same way, free (the
 * text readers, no model), so a misread is put right without the owner pressing anything. Bills
 * the owner edited are left. Results kept for the audit report (`figure-check:last`).
 */
export async function nightlyFigureCheck(): Promise<{ accounts: number; fixed: number; feesRemoved: number; emailSplit: number; loans: number }> {
  const accounts = await db.utilityAccount.findMany({
    where: { isActive: true, statements: { some: { statementDate: { gte: new Date(Date.now() - 75 * 86_400_000) } } } },
    select: { id: true, property: { select: { userId: true } } },
  });
  let fixed = 0, feesRemoved = 0, emailSplit = 0, loans = 0;
  for (const a of accounts) {
    const r = await recheckAccount(a.property.userId, a.id, { recentDays: 75 }).catch(() => null);
    if (!r) continue;
    fixed += r.fixed; feesRemoved = r2(feesRemoved + Math.max(0, r.feesRemoved)); emailSplit += r.emailSplit;
    if (r.loan && !('none' in r.loan)) loans++;
  }
  return { accounts: accounts.length, fixed, feesRemoved, emailSplit, loans };
}
