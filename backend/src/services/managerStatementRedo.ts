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

import pdfParse from '../lib/pdfParse';
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

export interface RedoSummary {
  statements: number; notStatements: number; rent: number; loanPayments: number; expenses: number; needsLook: number;
  /** Statements that could not be recorded again (each left undone, with why). */
  failed: string[];
}

/** Undo and record again every emailed statement from this manager, oldest first. */
export async function redoManagerStatements(userId: string, profileId: string,
  deps: { download?: (key: string) => Promise<Buffer> } = {}): Promise<RedoSummary> {
  const sum: RedoSummary = { statements: 0, notStatements: 0, rent: 0, loanPayments: 0, expenses: 0, needsLook: 0, failed: [] };
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
  // One that fails is reported and left undone; the rest still go (one bad statement left them all undone).
  for (const st of keep) {
    const when = (st.receivedAt ?? st.statementDate).toISOString().slice(0, 10);
    try {
      const done = await recordFromLines(userId, st);
      if (!done) { sum.failed.push(`${when}: its lines were not kept — delete it and fetch it again`); continue; }
      sum.statements++; sum.rent += done.rent; sum.loanPayments += done.loanPayments; sum.expenses += done.expenses; sum.needsLook += done.needsLook;
    } catch (err) {
      const why = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : String(err);
      console.warn(`[Manager] statement ${st.id} not recorded again:`, why);
      await db.reconciliationStatement.update({ where: { id: st.id }, data: { status: 'UNDONE' } }).catch(() => {});
      sum.failed.push(`${when}: ${why}`);
    }
  }
  return sum;
}

/**
 * One statement recorded again from the lines it was read with (no new AI read), matched with what the
 * owner has chosen since (lineRules) and against what is recorded now. Null when its lines were not kept.
 */
async function recordFromLines(userId: string, st: { id: string; profileId: string; draftJson: unknown }) {
  const d = (st.draftJson && typeof st.draftJson === 'object' ? st.draftJson : {}) as Record<string, any>;
  if (!Array.isArray(d.lines)) return null;
  const raw = {
    manager: d.manager, periodStart: d.periodStart, periodEnd: d.periodEnd, statementDate: d.statementDate,
    beginningBalance: d.beginningBalance, endingBalance: d.endingBalance,
    lines: d.lines.map((l: any) => ({ date: l.date, property: l.propertyHint, payee: l.payee, unit: l.unit, description: l.description, kind: l.kind, amount: l.amount, direction: l.direction })),
  };
  const draft = await matchManagerStatement(userId, raw, st.profileId);
  const { lineItems, needsLook, reviewDraft, net } = statementFromDraft({ ...draft, documentKey: d.documentKey });
  await db.reconciliationStatement.update({
    where: { id: st.id },
    data: { status: 'DRAFT', lineItems: lineItems as unknown as Prisma.InputJsonValue, netAmount: net, draftJson: { ...reviewDraft, documentKey: d.documentKey, needsLook, verified: true } as unknown as Prisma.InputJsonValue },
  });
  const done = await applyManagerStatement(userId, st.id);
  return { ...done, needsLook };
}

/**
 * Record one statement again (an undone one, or one to refresh): what it recorded before is removed first,
 * then it is recorded from its lines with today's choices. Lines another recorded statement has are skipped.
 */
export async function recordStatementAgain(userId: string, id: string) {
  const st = await db.reconciliationStatement.findFirst({ where: { id, userId } });
  if (!st) throw Object.assign(new Error('Statement not found'), { status: 404 });
  if (st.status === 'NOT_A_STATEMENT') throw Object.assign(new Error('This PDF was set aside as not a statement.'), { status: 409 });
  if (st.status === 'APPLIED') await undoManagerStatement(userId, id, 'UNDONE');
  const done = await recordFromLines(userId, st);
  if (!done) throw Object.assign(new Error('Its lines were not kept — delete it and fetch it again (Check email now), or upload it.'), { status: 409 });
  return done;
}

/** Delete a statement, with what it recorded (rent, loan payments, costs). An emailed one can then be fetched again. */
export async function deleteManagerStatement(userId: string, id: string): Promise<void> {
  const st = await db.reconciliationStatement.findFirst({ where: { id, userId }, select: { id: true, status: true } });
  if (!st) throw Object.assign(new Error('Statement not found'), { status: 404 });
  if (st.status === 'APPLIED') await undoManagerStatement(userId, id, 'UNDONE');
  await db.reconciliationStatement.delete({ where: { id } });
}

export interface StartOverSummary {
  deleted: number;
  fetched: { mailboxes: number; looked: number; found: number; recorded: number; already: number; details: string[]; errors: string[] };
}

/**
 * Start over for one manager: every statement deleted with what it recorded —
 * emailed and uploaded alike; PDFs set aside as not statements are kept so they
 * are not read again — then the manager's emails are fetched again, back to the
 * oldest one deleted, and each read and recorded afresh, oldest first. The
 * manager's remembered choices and addresses stay, so the lines fill themselves in.
 */
export async function startOverManager(userId: string, profileId: string,
  deps: { fetch?: (userId: string, days: number) => Promise<StartOverSummary['fetched']> } = {}): Promise<StartOverSummary> {
  const sts = await db.reconciliationStatement.findMany({
    where: { userId, profileId, status: { not: 'NOT_A_STATEMENT' } },
    select: { id: true, receivedAt: true, statementDate: true },
  });
  const oldest = Math.min(Date.now(), ...sts.map(s => (s.receivedAt ?? s.statementDate).getTime()));
  for (const s of sts) await deleteManagerStatement(userId, s.id);
  // Far enough back for the oldest one, with a little room (and never under the usual six months).
  const days = Math.min(400, Math.max(180, Math.ceil((Date.now() - oldest) / 86_400_000) + 10));
  // Loaded here: the fetch reads Gmail through the inbox agent, which tests leave out.
  const fetch = deps.fetch ?? (await import('./managerStatementFetch')).fetchManagerStatements;
  return { deleted: sts.length, fetched: await fetch(userId, days) };
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
