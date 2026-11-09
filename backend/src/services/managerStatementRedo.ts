/**
 * Putting a manager's emailed statements right after the fact.
 *
 * - Undo: what a statement recorded (rent, loan payments, costs) is removed and the
 *   statement is kept as UNDONE, so the email is not fetched again.
 * - Redo: every emailed statement from the manager is undone, then each is recorded
 *   again, oldest first, from the lines it was read with (no new AI read) — with
 *   what the owner has chosen since (lineRules) and against what is recorded now.
 *   A PDF from the manager that is not a statement at all (a lender's letter or
 *   schedule from the same address) is set aside as NOT_A_STATEMENT, nothing recorded.
 *   Run when the owner saves a review, from the Redo button, and once at worker start
 *   for statements fetched before PDFs were checked this way.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { matchManagerStatement } from './managerStatement';
import { applyManagerStatement, statementFromDraft } from './managerStatementApply';
import { isManagerStatementPdf } from './managerStatementEmail';
import { downloadDocument } from './s3Service';

const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
/** Remove what a statement recorded; keep it (as UNDONE or NOT_A_STATEMENT) so its email is not fetched again. */
export async function undoManagerStatement(userId: string, id: string, status: 'UNDONE' | 'NOT_A_STATEMENT' = 'UNDONE') {
  const st = await db.reconciliationStatement.findFirst({ where: { id, userId } });
  if (!st) throw Object.assign(new Error('Statement not found'), { status: 404 });
  const ids = (st.createdRecordIds ?? {}) as { rentPaymentIds?: string[]; loanPaymentIds?: string[]; expenseIds?: string[] };
  await db.$transaction([
    db.rentPayment.deleteMany({ where: { id: { in: ids.rentPaymentIds ?? [] }, lease: { unit: { property: { userId } } } } }),
    db.loanPayment.deleteMany({ where: { id: { in: ids.loanPaymentIds ?? [] }, loan: { userId } } }),
    db.expense.deleteMany({ where: { id: { in: ids.expenseIds ?? [] }, userId } }),
    db.reconciliationStatement.update({ where: { id }, data: { status, appliedAt: null, createdRecordIds: Prisma.DbNull } }),
  ]);
}

export interface RedoSummary { statements: number; notStatements: number; rent: number; loanPayments: number; expenses: number; needsLook: number }

/** Undo and record again every emailed statement from this manager, oldest first. */
export async function redoManagerStatements(userId: string, profileId: string,
  deps: { download?: (key: string) => Promise<Buffer> } = {}): Promise<RedoSummary> {
  const sum: RedoSummary = { statements: 0, notStatements: 0, rent: 0, loanPayments: 0, expenses: 0, needsLook: 0 };
  const sts = await db.reconciliationStatement.findMany({
    where: { userId, profileId, source: 'email', status: { not: 'NOT_A_STATEMENT' } },
    orderBy: [{ receivedAt: 'asc' }, { statementDate: 'asc' }, { createdAt: 'asc' }],
  });
  // 1. Each PDF checked once: a lender's letter from the manager's address is not a statement. Then all undone.
  const keep: typeof sts = [];
  for (const st of sts) {
    const d = (st.draftJson && typeof st.draftJson === 'object' ? st.draftJson : {}) as Record<string, any>;
    if (!d.verified && st.documentS3Key) {
      let text = '';
      try { text = (await pdfParse(await (deps.download ?? downloadDocument)(st.documentS3Key))).text; } catch { /* unreadable: kept as it is */ }
      if (text && !isManagerStatementPdf(text, true)) {
        await undoManagerStatement(userId, st.id, 'NOT_A_STATEMENT');
        sum.notStatements++;
        continue;
      }
    }
    if (st.status === 'APPLIED') await undoManagerStatement(userId, st.id, 'UNDONE');
    keep.push(st);
  }
  // 2. Each recorded again from the lines it was read with, against what is recorded now.
  for (const st of keep) {
    const d = (st.draftJson && typeof st.draftJson === 'object' ? st.draftJson : {}) as Record<string, any>;
    if (!Array.isArray(d.lines)) continue;
    const raw = {
      manager: d.manager, periodStart: d.periodStart, periodEnd: d.periodEnd, statementDate: d.statementDate,
      beginningBalance: d.beginningBalance, endingBalance: d.endingBalance,
      lines: d.lines.map((l: any) => ({ date: l.date, property: l.propertyHint, payee: l.payee, unit: l.unit, description: l.description, kind: l.kind, amount: l.amount, direction: l.direction })),
    };
    const draft = await matchManagerStatement(userId, raw, profileId);
    const { lineItems, needsLook, reviewDraft, net } = statementFromDraft({ ...draft, documentKey: d.documentKey });
    await db.reconciliationStatement.update({
      where: { id: st.id },
      data: { status: 'DRAFT', lineItems: lineItems as unknown as Prisma.InputJsonValue, netAmount: net, draftJson: { ...reviewDraft, documentKey: d.documentKey, needsLook, verified: true } as unknown as Prisma.InputJsonValue },
    });
    const done = await applyManagerStatement(userId, st.id);
    sum.statements++; sum.rent += done.rent; sum.loanPayments += done.loanPayments; sum.expenses += done.expenses; sum.needsLook += needsLook;
  }
  return sum;
}

/** Once, at worker start: managers whose emailed statements were never checked are redone. */
export async function redoUncheckedManagerStatements(): Promise<void> {
  const sts = await db.reconciliationStatement.findMany({ where: { source: 'email', status: { not: 'NOT_A_STATEMENT' } }, select: { userId: true, profileId: true, draftJson: true } });
  const todo = new Map<string, string>();
  for (const s of sts) if (!(s.draftJson as any)?.verified) todo.set(s.profileId, s.userId);
  for (const [profileId, userId] of todo) {
    try { const r = await redoManagerStatements(userId, profileId); console.log(`[Manager] redone ${r.statements} statement(s), ${r.notStatements} not statements, for profile ${profileId}`); }
    catch (e) { console.warn('[Manager] redo failed', profileId, e instanceof Error ? e.message : e); }
  }
}
