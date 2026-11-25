/**
 * Statements already on file read again by the free text readers that check their own arithmetic:
 * an HOA manager's running ledger (applyLedgerFromText) and a credit union's loan statement
 * (applyLoanStatementFromText). Bills those layouts were read wrong — an HOA bill as its whole
 * balance, a loan bill as its total plus the past due again, or as $0 — kept their figures until
 * the owner re-read each account, and re-reading needed the model. This reads each saved PDF's
 * text layer (no model), and where a reader takes the bill and its figures differ from what is
 * stored, the stored figures follow it: the bill's own charge, what it carried, its printed total,
 * its due date, its ledger payments and loan figures. Fees logged with payments and fees folded
 * into the next bill go back on (restoreLateFees), the late-fee check runs again for the account,
 * and a loan statement brings its loan up to date. Bills the owner edited are left.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { downloadDocument } from './s3Service';
import { applyLedgerFromText, applyLoanStatementFromText, type ExtractedBillData } from './pdfImportService';
import { restoreLateFees } from './lateFees';
import { settleCarriedFees } from './carriedFees';
import { syncLoanFromStatement } from './loanStatements';
import pdfParse from '../lib/pdfParse';
const near = (a: unknown, b: unknown) => Math.abs(Number(a ?? 0) - Number(b ?? 0)) < 0.01;

export interface RecheckLine {
  statementId: string; statementDate: string;
  outcome: 'fixed' | 'same' | 'not-read' | 'owner-edited' | 'email';
  before?: { charge: number; carried: number | null }; after?: { charge: number; carried: number | null; total: number };
}

export async function recheckStoredStatements(opts: {
  userId?: string; categories?: string[]; textOf?: (pdfKey: string) => Promise<string>;
  /** Only these accounts (any category). */
  accountIds?: string[];
  /** Also bills the owner edited by hand: the owner asked for the PDF's figures. */
  includeOwnerEdited?: boolean;
} = {}): Promise<{ checked: number; fixed: number; loans: number; lines: RecheckLine[] }> {
  const rows = await db.statement.findMany({
    where: {
      pdfS3Key: { not: null }, isDownPayment: false, isScheduled: false,
      ...(opts.accountIds ? { utilityAccountId: { in: opts.accountIds } } : {}),
      utilityAccount: {
        ...(opts.accountIds ? {} : { category: { in: (opts.categories ?? ['LOAN', 'HOA', 'OTHER']) as never[] } }),
        ...(opts.userId ? { property: { userId: opts.userId } } : {}),
      },
    },
    orderBy: { statementDate: 'asc' },
    select: { id: true, utilityAccountId: true, pdfS3Key: true, statementDate: true, amountDue: true, pastDueCarried: true, carriedFee: true, rawDataJson: true },
  });
  let checked = 0, fixed = 0, loans = 0;
  const lines: RecheckLine[] = [];
  const touched = new Set<string>();
  for (const s of rows) {
    const raw = (s.rawDataJson && typeof s.rawDataJson === 'object' && !Array.isArray(s.rawDataJson) ? s.rawDataJson : {}) as Record<string, unknown>;
    const line: RecheckLine = { statementId: s.id, statementDate: s.statementDate.toISOString().slice(0, 10), outcome: 'not-read' };
    if (raw.emailNotice) { lines.push({ ...line, outcome: 'email' }); continue; }
    if (raw.ownerEditedAt && !opts.includeOwnerEdited) { lines.push({ ...line, outcome: 'owner-edited' }); continue; }
    let text = '';
    try { text = opts.textOf ? await opts.textOf(s.pdfS3Key!) : (await pdfParse(await downloadDocument(s.pdfS3Key!))).text ?? ''; } catch { lines.push(line); continue; }
    checked++;
    const ex = {} as ExtractedBillData;
    applyLedgerFromText(text, ex);
    if (ex.amountDue == null) applyLoanStatementFromText(text, ex);
    if (ex.amountDue == null || ex.statedTotalDue == null) {
      // A loan statement whose figures do not add up still tells its loan the balance and rate.
      if (ex.loanStatement) { ex.statementDate = s.statementDate.toISOString().slice(0, 10); if (await syncLoanFromStatement(s.utilityAccountId, ex).catch(() => null)) loans++; }
      lines.push(line);
      continue;
    }
    const carried = ex.previousBalance != null && Math.abs(ex.previousBalance) > 0.005 ? ex.previousBalance : null;
    const ownCharge = Number(s.amountDue ?? 0) - Number(s.carriedFee ?? 0);
    const same = near(ownCharge, ex.amountDue) && near(s.pastDueCarried, carried) && near(raw.statedTotalDue, ex.statedTotalDue)
      && (!ex.ledgerPayments?.length || Array.isArray(raw.ledgerPayments)) && (!ex.loanStatement || !!raw.loanStatement);
    const beforeFig = { charge: Number(s.amountDue ?? 0), carried: s.pastDueCarried != null ? Number(s.pastDueCarried) : null };
    if (same) lines.push({ ...line, outcome: 'same', before: beforeFig });
    if (!same) {
      await db.statement.update({
        where: { id: s.id },
        data: {
          amountDue: ex.amountDue,
          chargesExcludingFees: ex.currentCharges ?? ex.amountDue,
          pastDueCarried: carried,
          balance: ex.statedTotalDue,
          penaltiesFees: null,
          ...(ex.dueDate ? { dueDate: new Date(`${ex.dueDate}T00:00:00Z`) } : {}),
          rawDataJson: {
            ...raw,
            statedTotalDue: ex.statedTotalDue, totalDue: ex.statedTotalDue, previousBalance: ex.previousBalance ?? null, pastDue: carried ?? undefined,
            currentCharges: ex.currentCharges ?? ex.amountDue, paymentsReceived: ex.paymentsReceived ?? null,
            ...(ex.chargeBreakdown ? { chargeBreakdown: ex.chargeBreakdown } : {}),
            ledgerPayments: ex.ledgerPayments ?? null, loanStatement: ex.loanStatement ?? null,
            recheckedFromText: new Date().toISOString().slice(0, 10),
            // The owner asked for the PDF's figures over their own: theirs are no longer kept.
            ...(raw.ownerEditedAt && opts.includeOwnerEdited ? { ownerEditedAt: undefined, ownerFiguresReplacedAt: new Date().toISOString() } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      // Fees logged with payments and fees folded into the next bill are not on the PDF: they go back on.
      await restoreLateFees(s.id, null);
      fixed++;
      touched.add(s.utilityAccountId);
      lines.push({ ...line, outcome: 'fixed', before: beforeFig, after: { charge: ex.amountDue, carried, total: ex.statedTotalDue } });
    }
    if (ex.loanStatement) {
      ex.statementDate = s.statementDate.toISOString().slice(0, 10);
      if (await syncLoanFromStatement(s.utilityAccountId, ex).catch(() => null)) loans++;
    }
  }
  for (const id of touched) await settleCarriedFees(id).catch(() => null);
  return { checked, fixed, loans, lines };
}
