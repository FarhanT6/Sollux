/**
 * Recording a manager's statement: each line it records becomes the owner's
 * record — rent a RentPayment for the month of the line's date, a loan line a
 * LoanPayment for that month (paid by the manager out of the rent), a fee or
 * repair the property's expense. Used by Record on the page and by statements
 * fetched from email, which are recorded on their own.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { COST_KINDS, lineKey, type LineKind, type LineRule, type LoanSplit } from '../lib/managerStatementMatch';
import type { StatementDraft } from './managerStatement';

/** A reviewed line as the owner left it (the draft's lines, edited). */
export interface ReviewedLine {
  date?: string | null; description: string; kind: string; amount: number; direction: 'IN' | 'OUT';
  propertyId?: string | null; leaseId?: string | null; loanId?: string | null; category?: string | null; bankAccountId?: string | null; include: boolean;
  splits?: LoanSplit[] | null;
}

/**
 * The statement's stored lines. A line is recorded only when it points at its record: rent at a lease,
 * a loan line at a loan, a cost or reimbursement at a property. "You paid the manager" is kept (with the
 * account it came from) but records nothing: it funds the other lines, which are recorded themselves.
 */
/** Parts that each name a loan and add up to the line. */
const validSplits = (l: { amount: number; splits?: LoanSplit[] | null }) =>
  !!l.splits && l.splits.length > 1 && l.splits.every(p => p.loanId && p.amount > 0) && Math.abs(l.splits.reduce((t, p) => t + p.amount, 0) - l.amount) < 0.01;

export function lineItemsFrom(lines: ReviewedLine[]) {
  return lines.map(l => {
    const cost = COST_KINDS.includes(l.kind as LineKind);
    const type = l.kind === 'RENT' ? 'RENT' : l.kind === 'LOAN_PAYMENT' ? 'LOAN_PAYMENT' : cost ? 'EXPENSE' : 'OTHER';
    return {
      type, targetId: l.kind === 'RENT' ? l.leaseId ?? null : l.kind === 'LOAN_PAYMENT' ? l.loanId ?? null : null,
      targetLabel: l.kind, description: l.description, amount: l.amount, direction: l.direction === 'IN' ? 'CREDIT' : 'DEBIT',
      date: l.date ?? null, category: l.category ?? null, propertyId: l.propertyId ?? null, bankAccountId: l.kind === 'OWNER_PAYMENT' ? l.bankAccountId ?? null : null,
      // Kept whole (so the next statement's same line is known), with its parts when it paid several loans.
      splits: type === 'LOAN_PAYMENT' && validSplits(l) ? l.splits : null,
      include: l.include && (type === 'RENT' || type === 'LOAN_PAYMENT' ? !!(l.leaseId || l.loanId) : type === 'EXPENSE' ? !!l.propertyId : true),
    };
  });
}

/**
 * Remember what the owner chose for each line (its kind and record, by its wording) on the manager's profile,
 * so the next statement's same lines are filled in and recorded the same way.
 */
export async function learnLineRules(profileId: string, lines: ReviewedLine[]) {
  const p = await db.reconciliationProfile.findUnique({ where: { id: profileId }, select: { lineRules: true } });
  const rules = { ...((p?.lineRules && typeof p.lineRules === 'object' && !Array.isArray(p.lineRules) ? p.lineRules : {}) as unknown as Record<string, LineRule>) };
  let changed = false;
  for (const l of lines) {
    const key = lineKey(l.description);
    if (!key || l.kind === 'OTHER') continue;
    // Only a choice that was made: a recorded line with its record, or a line kept on purpose (paid by / sent to the owner).
    const chosen = l.kind === 'OWNER_PAYMENT' || l.kind === 'OWNER_DRAW'
      || (l.include && (l.kind === 'RENT' ? !!l.leaseId : l.kind === 'LOAN_PAYMENT' ? !!l.loanId : COST_KINDS.includes(l.kind as LineKind) ? !!l.propertyId : false));
    if (!chosen) continue;
    const before = rules[key];
    if (l.kind === 'LOAN_PAYMENT' && validSplits(l)) {
      // A split is remembered for lines of this exact total; the line's loan otherwise stays what it was.
      const splits = [...(before?.splits ?? []).filter(sp => Math.abs(sp.total - l.amount) >= 0.005), { total: l.amount, parts: l.splits! }];
      rules[key] = { ...(before ?? { kind: 'LOAN_PAYMENT' }), kind: 'LOAN_PAYMENT', loanId: before?.loanId ?? l.splits![0].loanId, propertyId: l.propertyId ?? before?.propertyId ?? null, splits };
      changed = true;
      continue;
    }
    rules[key] = { kind: l.kind as LineKind, propertyId: l.propertyId ?? null, leaseId: l.leaseId ?? null, loanId: l.loanId ?? null, category: l.category ?? null, bankAccountId: l.bankAccountId ?? null, ...(before?.splits ? { splits: before.splits } : {}) };
    changed = true;
  }
  if (changed) await db.reconciliationProfile.update({ where: { id: profileId }, data: { lineRules: rules as unknown as Prisma.InputJsonValue } });
}

interface Item {
  type: 'RENT' | 'LOAN_PAYMENT' | 'EXPENSE' | 'OTHER'; targetId?: string | null; description?: string | null;
  amount: number; direction: 'CREDIT' | 'DEBIT'; date?: string | null; category?: string | null; propertyId?: string | null; include?: boolean;
  /** A loan line that paid several loans: each part recorded on its loan. */
  splits?: LoanSplit[] | null;
}

const COSTLIKE = ['RENT', 'LOAN_PAYMENT', 'MANAGEMENT_FEE', 'REPAIR', 'UTILITY', 'OTHER_EXPENSE', 'REIMBURSEMENT'];

/** A read statement as stored: its lines, what records itself, and what is left for the owner. */
export function statementFromDraft(draft: StatementDraft & { documentKey?: string }) {
  const lineItems = lineItemsFrom(draft.lines);
  const recordable = new Set(lineItems.map((li, i) => (li.include ? i : -1)).filter(i => i >= 0));
  const needsLook = draft.lines.filter((l, i) => !recordable.has(i) && !l.onEarlierStatement && !l.alreadyRecorded && COSTLIKE.includes(l.kind)).length;
  const reviewDraft = { ...draft, lines: draft.lines.map((l, i) => (recordable.has(i) ? { ...l, include: false, recordedNow: true } : { ...l, recordedNow: false })) };
  const net = lineItems.reduce((t, li) => t + (li.direction === 'CREDIT' ? li.amount : -li.amount), 0);
  return { lineItems, needsLook, reviewDraft, net: Math.round(net * 100) / 100 };
}

export async function applyManagerStatement(userId: string, statementId: string) {
  const statement = await db.reconciliationStatement.findFirst({ where: { id: statementId, userId } });
  if (!statement) throw Object.assign(new Error('Statement not found'), { status: 404 });
  if (statement.status === 'APPLIED') throw Object.assign(new Error('Statement has already been applied'), { status: 400 });
  const profile = await db.reconciliationProfile.findFirst({ where: { id: statement.profileId, userId } });
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 });

  const lineItems = statement.lineItems as unknown as Item[];
  // A line another of this manager's recorded statements already recorded is not recorded again
  // (the same month read twice: a statement uploaded by hand and also emailed, a year-to-date repeat).
  const key = (li: Item) => `${li.date ?? ''}|${Number(li.amount).toFixed(2)}|${li.direction === 'CREDIT' ? 'C' : 'D'}|${String(li.description ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
  const recorded = new Map<string, number>();
  for (const other of await db.reconciliationStatement.findMany({ where: { userId, profileId: statement.profileId, status: 'APPLIED', id: { not: statement.id } }, select: { lineItems: true } })) {
    const counts = new Map<string, number>();
    for (const li of (Array.isArray(other.lineItems) ? other.lineItems : []) as unknown as Item[]) if (li.include !== false) counts.set(key(li), (counts.get(key(li)) ?? 0) + 1);
    for (const [k, n] of counts) recorded.set(k, Math.max(recorded.get(k) ?? 0, n));
  }
  const periodDate = new Date(Date.UTC(statement.statementDate.getUTCFullYear(), statement.statementDate.getUTCMonth(), 1));
  const monthOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const rentPaymentIds: string[] = [], loanPaymentIds: string[] = [], expenseIds: string[] = [];

  await db.$transaction(async tx => {
    for (const item of lineItems) {
      if (item.include === false) continue;
      const left = recorded.get(key(item)) ?? 0;
      if (left > 0) { recorded.set(key(item), left - 1); continue; }
      const itemDate = item.date ? new Date(`${item.date.slice(0, 10)}T00:00:00.000Z`) : statement.statementDate;
      const note = `Reconciled via ${profile.name} statement (${item.description ?? ''})`.trim();
      if (item.type === 'RENT' && item.targetId) {
        const p = await tx.rentPayment.create({
          data: { leaseId: item.targetId, periodDate: item.date ? monthOf(itemDate) : periodDate, amount: item.amount, paidDate: itemDate, method: 'OTHER', notes: note },
        });
        rentPaymentIds.push(p.id);
      } else if (item.type === 'LOAN_PAYMENT' && item.targetId) {
        // Paid for the month the statement shows it; the manager took it out of the rent. A line that paid
        // several loans records each loan's part.
        for (const part of item.splits?.length ? item.splits : [{ loanId: item.targetId, amount: item.amount }]) {
          if (!(await tx.loan.findFirst({ where: { id: part.loanId, userId }, select: { id: true } }))) continue;
          const p = await tx.loanPayment.create({
            data: { loanId: part.loanId, date: itemDate, periodDate: monthOf(itemDate), amount: part.amount, status: 'PAID', method: 'DEDUCTED', notes: item.splits?.length ? `${note} — part of ${item.amount.toFixed(2)}` : note },
          });
          loanPaymentIds.push(p.id);
        }
      } else if (item.type === 'EXPENSE' && (item.propertyId ?? profile.propertyId)) {
        const e = await tx.expense.create({
          data: {
            userId, propertyId: (item.propertyId ?? profile.propertyId)!, category: (item.category ?? profile.managementFeeCategory ?? 'PROPERTY_MANAGEMENT') as any,
            // Money paid back toward a cost (a tenant's tax reimbursement) offsets it.
            amount: item.direction === 'CREDIT' ? -Math.abs(item.amount) : item.amount, date: itemDate, vendor: profile.name, description: item.description || undefined, isCapEx: false, isPersonal: false,
          },
        });
        expenseIds.push(e.id);
      }
    }
    await tx.reconciliationStatement.update({
      where: { id: statement.id },
      data: { status: 'APPLIED', appliedAt: new Date(), createdRecordIds: { rentPaymentIds, loanPaymentIds, expenseIds } as unknown as Prisma.InputJsonValue },
    });
  });
  return { rent: rentPaymentIds.length, loanPayments: loanPaymentIds.length, expenses: expenseIds.length };
}
