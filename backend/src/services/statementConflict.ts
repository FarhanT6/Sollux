/**
 * A bill read from a PDF against a statement the owner entered by hand.
 *
 * Importing used to overwrite whatever statement it found for the period
 * with the PDF's reading. That is right when the statement came from an
 * earlier import, and wrong when the owner typed the figures in, or
 * corrected them, themselves: a misread (Westlake's "$5.00") silently
 * replaced a figure the owner knew to be right. Now:
 *
 *  - the reading agrees with the owner's amount: the owner's figures stay
 *    and the PDF, charge list and payments it lists are added;
 *  - it disagrees: nothing is filed until the owner chooses, on the review
 *    card, between the statement's figures and their own;
 *  - the statement was not the owner's: it is updated as before.
 *
 * "Entered by hand" is a statement with no import data (created from the
 * Add statement form) or one whose figures the owner has edited since
 * (rawDataJson.ownerEditedAt, set by PATCH /api/statements/:id).
 */
import { Prisma, Statement } from '@prisma/client';
import { db } from '../config/db';
import { LATE_FEE_LINE } from './lateFees';
import type { ExtractedBillData } from './pdfImportService';

export interface StatementConflict {
  utilityAccountId: string;
  statementId: string;
  statementDate: string;            // YYYY-MM-DD of the owner's statement
  ownerAmount: number;              // what the owner entered, less late fees logged with payments
  statementAmount: number;          // what this bill reads as the period's charge
}

export function ownerEntered(s: { rawDataJson: unknown }): boolean {
  const raw = s.rawDataJson as Record<string, unknown> | null;
  return !raw || typeof raw !== 'object' || Array.isArray(raw) || !!raw.ownerEditedAt;
}

/**
 * The statement a bill would update: the same billing period (start within
 * a week), or, failing that, the same issue month among rows that carry no
 * real period of their own. The rule every import path uses.
 */
export async function samePeriodStatement(utilityAccountId: string, ex: ExtractedBillData): Promise<Statement | null> {
  if (ex.billingPeriodStart) {
    const start = new Date(ex.billingPeriodStart);
    const window = 7 * 24 * 60 * 60 * 1000;
    const hit = await db.statement.findFirst({
      where: { utilityAccountId, billingPeriodStart: { gte: new Date(start.getTime() - window), lte: new Date(start.getTime() + window) } },
    });
    if (hit) return hit;
  }
  if (!ex.statementDate) return null;
  const d = new Date(ex.statementDate);
  if (isNaN(d.getTime())) return null;
  const DAY = 24 * 60 * 60 * 1000;
  const firstOfMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return db.statement.findFirst({
    where: {
      utilityAccountId,
      statementDate: { gte: new Date(firstOfMonth), lte: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59)) },
      OR: [{ billingPeriodStart: null }, { billingPeriodStart: { gte: new Date(firstOfMonth - DAY), lte: new Date(firstOfMonth + DAY) } }],
    },
  });
}

async function loggedLateFees(statementId: string): Promise<number> {
  const agg = await db.payment.aggregate({ where: { statementId, lateFeeAdded: { gt: 0 } }, _sum: { lateFeeAdded: true } });
  return Number(agg._sum.lateFeeAdded ?? 0);
}

const periodCharge = (ex: ExtractedBillData) => ex.currentCharges ?? ex.amountDue ?? null;

/** How the owner's statement compares with this bill: 'none' (no hand-entered statement or no amount on it), 'same', or the conflict. */
export async function compareWithOwner(utilityAccountId: string, ex: ExtractedBillData, existing?: Statement | null): Promise<{ kind: 'none' } | { kind: 'same'; statement: Statement } | { kind: 'conflict'; statement: Statement; conflict: StatementConflict }> {
  const s = existing === undefined ? await samePeriodStatement(utilityAccountId, ex) : existing;
  const charge = periodCharge(ex);
  if (!s || !ownerEntered(s) || s.amountDue == null || charge == null) return { kind: 'none' };
  const own = Number(s.amountDue) - await loggedLateFees(s.id);
  if (Math.abs(own - charge) <= 0.01) return { kind: 'same', statement: s };
  // The owner already kept their figure against this same reading; do not ask again.
  const said = (s.rawDataJson as Record<string, unknown> | null)?.statementSaid;
  if (typeof said === 'number' && Math.abs(said - charge) <= 0.01) return { kind: 'same', statement: s };
  return {
    kind: 'conflict', statement: s,
    conflict: { utilityAccountId, statementId: s.id, statementDate: s.statementDate.toISOString().slice(0, 10), ownerAmount: Number(own.toFixed(2)), statementAmount: Number(charge.toFixed(2)) },
  };
}

/**
 * Files a bill onto the owner's statement without touching their figures:
 * the PDF if the statement has none, the dates the owner left blank, and
 * the bill's reading (charge list, payments, account details) in its raw
 * data. When the bill disagreed and the owner kept theirs, what the bill
 * said is recorded beside it.
 */
export async function keepOwnerFigures(existing: Statement, ex: ExtractedBillData, rawData: Record<string, unknown>, pdfS3Key: string | null): Promise<void> {
  const prior = (existing.rawDataJson ?? {}) as Record<string, any>;
  const charge = periodCharge(ex);
  const own = existing.amountDue != null ? Number(existing.amountDue) - await loggedLateFees(existing.id) : null;
  const differs = charge != null && own != null && Math.abs(own - charge) > 0.01;
  // The charge list explains the amount on the row. When the owner kept a
  // different amount, the statement's lines do not; they are kept aside.
  const breakdown: Record<string, number> = differs
    ? { ...((prior?.chargeBreakdown as Record<string, number> | null) ?? {}) }
    : { ...((rawData.chargeBreakdown as Record<string, number> | null) ?? {}) };
  // A late fee logged with a payment is on the owner's statement, not the PDF.
  if (prior?.chargeBreakdown?.[LATE_FEE_LINE] != null) breakdown[LATE_FEE_LINE] = prior.chargeBreakdown[LATE_FEE_LINE];
  await db.statement.update({
    where: { id: existing.id },
    data: {
      dueDate: existing.dueDate ?? (ex.dueDate ? new Date(ex.dueDate) : null),
      billingPeriodStart: existing.billingPeriodStart ?? (ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : null),
      billingPeriodEnd: existing.billingPeriodEnd ?? (ex.billingPeriodEnd ? new Date(ex.billingPeriodEnd) : null),
      usageValue: existing.usageValue ?? ex.usageValue ?? null,
      usageUnit: existing.usageUnit ?? ex.usageUnit ?? null,
      ...(pdfS3Key && !existing.pdfS3Key ? { pdfS3Key } : {}),
      rawDataJson: {
        ...rawData,
        chargeBreakdown: Object.keys(breakdown).length ? breakdown : null,
        // Still the owner's: the next import compares against it again.
        ownerEditedAt: prior?.ownerEditedAt ?? new Date().toISOString(),
        confirmedByStatement: ex.statementDate ?? true,
        ...(differs ? { statementSaid: charge, statementBreakdown: rawData.chargeBreakdown ?? null } : {}),
      } as Prisma.InputJsonValue,
    },
  });
}

/**
 * The same bill found by its due date and amount, when its period did not
 * find it. A provider's "Your bill is ready" email prints no billing period,
 * so the period and issue-month lookups missed the PDF statement for the very
 * same bill (City of Brawley: the Sep 25 email and the Sep 30 PDF, both
 * $453.14 due Oct 15), and a second statement was created for it.
 */
export async function sameBillByDue(utilityAccountId: string, ex: ExtractedBillData): Promise<Statement | null> {
  if (!ex.dueDate) return null;
  const due = new Date(`${ex.dueDate.slice(0, 10)}T00:00:00Z`);
  if (isNaN(due.getTime())) return null;
  const window = 3 * 24 * 60 * 60 * 1000;
  const near = await db.statement.findMany({
    where: { utilityAccountId, dueDate: { gte: new Date(due.getTime() - window), lte: new Date(due.getTime() + window) } },
  });
  const charge = periodCharge(ex);
  const total = ex.statedTotalDue ?? null;
  const same = near.filter(s => {
    if (s.amountDue == null || charge == null) return true;
    const a = Number(s.amountDue), carried = Number(s.pastDueCarried ?? 0);
    return Math.abs(a - charge) <= 0.01 || (total != null && Math.abs(a + carried - total) <= 0.01);
  });
  return same.length === 1 ? same[0] : null;
}

/**
 * A reading with less in it than the statement already on file: no billing
 * period or charge lines where the statement has them. It confirms the bill
 * but must not replace it (the summary email over the PDF statement).
 */
export function thinnerThan(ex: ExtractedBillData, s: Statement): boolean {
  const lines = (r: unknown) => Object.keys(((r as any)?.chargeBreakdown ?? {}) as object).length;
  return !ex.billingPeriodStart && !!s.billingPeriodStart && lines(ex) <= lines(s.rawDataJson);
}
