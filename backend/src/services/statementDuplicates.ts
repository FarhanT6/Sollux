/**
 * Two statements that are one bill.
 *
 * Until the due-date match (statementConflict.sameBillByDue), a provider's
 * "your bill is ready" email was filed as a statement of its own beside the
 * PDF statement for the same bill: City of Brawley's Sep 25 summary and its
 * Sep 30 statement, both $453.14 due Oct 15. The same happened wherever a
 * provider sends a summary email and a statement. This finds those pairs
 * across the owner's accounts and merges each into the fuller statement.
 *
 * A pair: same account, due within 3 days of each other (or, with no due
 * dates, issued within 3 days), the same amount, and not two different
 * periods (at least one has no period, or both start within a week).
 */
import { Statement } from '@prisma/client';
import { db } from '../config/db';
import { syncStatementPaid } from '../routes/payments';

const DAY = 24 * 60 * 60 * 1000;
const amount = (s: Statement) => (s.amountDue == null ? null : Number(s.amountDue));
const lines = (s: Statement) => Object.keys(((s.rawDataJson as any)?.chargeBreakdown ?? {}) as object).length;
/** How much a statement holds: a period, charge lines, a PDF, a due date. */
const richness = (s: Statement) => (s.billingPeriodStart ? 4 : 0) + Math.min(lines(s), 3) + (s.pdfS3Key ? 1 : 0) + (s.dueDate ? 1 : 0);

function sameBill(a: Statement, b: Statement): boolean {
  if (a.isDownPayment || b.isDownPayment) return false;
  const close = (x: Date | null, y: Date | null) => !!x && !!y && Math.abs(x.getTime() - y.getTime()) <= 3 * DAY;
  if (!(a.dueDate && b.dueDate ? close(a.dueDate, b.dueDate) : close(a.statementDate, b.statementDate))) return false;
  const x = amount(a), y = amount(b);
  if (x == null || y == null) return false;
  const totalA = x + Number(a.pastDueCarried ?? 0), totalB = y + Number(b.pastDueCarried ?? 0);
  if (Math.abs(x - y) > 0.01 && Math.abs(totalA - totalB) > 0.01) return false;
  // Two real periods a month apart are two bills, whatever they cost.
  if (a.billingPeriodStart && b.billingPeriodStart && Math.abs(a.billingPeriodStart.getTime() - b.billingPeriodStart.getTime()) > 7 * DAY) return false;
  return true;
}

export interface DuplicatePair {
  keepId: string; dropId: string; utilityAccountId: string; propertyId: string;
  provider: string; property: string; amount: number | null; dueDate: string | null;
  keep: { statementDate: string; hasPeriod: boolean }; drop: { statementDate: string; hasPeriod: boolean };
}

export async function findDuplicates(userId: string): Promise<DuplicatePair[]> {
  const accounts = await db.utilityAccount.findMany({
    where: { property: { userId } },
    select: { id: true, providerName: true, propertyId: true, property: { select: { address: true, nickname: true } } },
  });
  const byId = new Map(accounts.map(a => [a.id, a]));
  const statements = await db.statement.findMany({
    where: { utilityAccountId: { in: accounts.map(a => a.id) } },
    orderBy: [{ utilityAccountId: 'asc' }, { statementDate: 'asc' }],
  });
  const groups = new Map<string, Statement[]>();
  for (const s of statements) (groups.get(s.utilityAccountId) ?? groups.set(s.utilityAccountId, []).get(s.utilityAccountId)!).push(s);

  const pairs: DuplicatePair[] = [];
  for (const [accountId, list] of groups) {
    const used = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (used.has(a.id) || used.has(b.id) || !sameBill(a, b)) continue;
        const [keep, drop] = richness(a) >= richness(b) ? [a, b] : [b, a];
        used.add(keep.id); used.add(drop.id);
        const acct = byId.get(accountId)!;
        const day = (d: Date) => d.toISOString().slice(0, 10);
        pairs.push({
          keepId: keep.id, dropId: drop.id, utilityAccountId: accountId, propertyId: acct.propertyId,
          provider: acct.providerName, property: acct.property.nickname || acct.property.address,
          amount: amount(keep), dueDate: (keep.dueDate ?? drop.dueDate) ? day((keep.dueDate ?? drop.dueDate)!) : null,
          keep: { statementDate: day(keep.statementDate), hasPeriod: !!keep.billingPeriodStart },
          drop: { statementDate: day(drop.statementDate), hasPeriod: !!drop.billingPeriodStart },
        });
      }
    }
  }
  return pairs;
}

/**
 * Folds `dropId` into `keepId`: its payments move over, anything the kept
 * statement lacks (a PDF, a due date, a period, a late fee the owner logged)
 * is taken from it, and it is deleted.
 */
export async function mergeStatements(userId: string, keepId: string, dropId: string): Promise<boolean> {
  const [keep, drop] = await Promise.all([
    db.statement.findFirst({ where: { id: keepId, utilityAccount: { property: { userId } } } }),
    db.statement.findFirst({ where: { id: dropId, utilityAccount: { property: { userId } } } }),
  ]);
  if (!keep || !drop || keep.id === drop.id || keep.utilityAccountId !== drop.utilityAccountId) return false;
  const moved = await db.payment.count({ where: { statementId: drop.id } });
  const keepBilled = await db.reimbursementInvoiceLine.findFirst({ where: { statementId: keep.id }, select: { id: true } });
  await db.$transaction([
    db.payment.updateMany({ where: { statementId: drop.id }, data: { statementId: keep.id } }),
    // A bank debit matched to the dropped row, and a tenant reimbursement
    // billed from it, follow it to the statement that stays.
    db.outgoingTransaction.updateMany({ where: { statementId: drop.id }, data: { statementId: keep.id } }),
    db.reimbursementInvoiceLine.updateMany({ where: { statementId: drop.id }, data: { statementId: keepBilled ? null : keep.id } }),
    db.statement.update({
      where: { id: keep.id },
      data: {
        pdfS3Key: keep.pdfS3Key ?? drop.pdfS3Key,
        dueDate: keep.dueDate ?? drop.dueDate,
        billingPeriodStart: keep.billingPeriodStart ?? drop.billingPeriodStart,
        billingPeriodEnd: keep.billingPeriodEnd ?? drop.billingPeriodEnd,
        paidOverride: keep.paidOverride ?? drop.paidOverride,
        notes: keep.notes ?? drop.notes,
        // Paid on either is paid: a bill the summary row was marked paid on.
        amountPaid: keep.amountPaid ?? drop.amountPaid,
      },
    }),
    db.statement.delete({ where: { id: drop.id } }),
  ]);
  // Paid state follows the payments when there are any on it now.
  if (moved) await syncStatementPaid(keep.id);
  return true;
}
