/**
 * A bill known only from its email: "Your statement is ready — amount due $4,000.00". The email
 * gives the total asked, not what this bill added; read as this bill's own charge, an HOA's
 * monthly assessment showed as a $4,000 bill because the balance before it was unpaid.
 *
 * What was carried in is the bill before's total less what was paid since; the rest is this
 * bill's charge. Only when the bill before printed its total, something of it is still unpaid,
 * and the email states no carried balance or separate charge of its own. The statement itself
 * replaces these figures when it comes.
 */
import { db } from '../config/db';
import type { ExtractedBillData } from './pdfImportService';

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const asNum = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The bill before `date` on the account, its printed total, and what was paid between the two. */
async function carriedInto(utilityAccountId: string, date: Date, excludeId?: string): Promise<{ carried: number; prevTotal: number; paid: number } | null> {
  const prev = await db.statement.findFirst({
    where: { utilityAccountId, isDownPayment: false, isScheduled: false, statementDate: { lt: date, gte: new Date(date.getTime() - 75 * DAY) }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    orderBy: { statementDate: 'desc' },
    select: { statementDate: true, amountDue: true, pastDueCarried: true, rawDataJson: true },
  });
  if (!prev) return null;
  const raw = (prev.rawDataJson && typeof prev.rawDataJson === 'object' ? prev.rawDataJson : {}) as Record<string, unknown>;
  const prevTotal = asNum(raw.statedTotalDue) ?? (prev.amountDue != null ? r2(Number(prev.amountDue) + Number(prev.pastDueCarried ?? 0)) : null);
  if (prevTotal == null || prevTotal <= 0) return null;
  const pays = await db.payment.aggregate({
    where: { utilityAccountId, status: { in: ['PAID', 'PARTIAL'] }, paymentDate: { gt: prev.statementDate, lte: date } },
    _sum: { amount: true },
  });
  const paid = Number(pays._sum.amount ?? 0);
  return { carried: r2(prevTotal - paid), prevTotal, paid };
}

/** Before an email's bill is saved: split its total into what was carried and this bill's charge. */
export async function splitEmailTotal(utilityAccountId: string, ex: ExtractedBillData): Promise<void> {
  if (!ex.fromEmailBody) return;
  if (ex.previousBalance != null && Math.abs(ex.previousBalance) > 0.005) return;
  const total = ex.statedTotalDue ?? ex.amountDue;
  if (total == null || total <= 0.5) return;
  if (ex.currentCharges != null && Math.abs(ex.currentCharges - total) > 0.01) return;
  const date = ex.statementDate ? new Date(`${ex.statementDate.slice(0, 10)}T00:00:00Z`) : new Date();
  const c = await carriedInto(utilityAccountId, date);
  if (!c || c.carried <= 0.5) return;
  const charge = r2(total - c.carried);
  if (charge <= 0.5) return;
  ex.previousBalance = c.carried;
  ex.currentCharges = charge;
  ex.amountDue = charge;
  ex.statedTotalDue = total;
}

/** Once: email bills already saved as their whole total, split the same way (oldest first, so each reads the one before as fixed). */
export async function repairEmailTotals(): Promise<number> {
  const rows = await db.statement.findMany({
    where: { pastDueCarried: null, isDownPayment: false, isScheduled: false, rawDataJson: { path: ['emailNotice'], equals: true } },
    orderBy: { statementDate: 'asc' },
    select: { id: true, utilityAccountId: true, statementDate: true, amountDue: true, rawDataJson: true },
  });
  let fixed = 0;
  for (const s of rows) {
    const raw = (s.rawDataJson ?? {}) as Record<string, unknown>;
    if (raw.ownerEditedAt) continue;
    const total = asNum(raw.statedTotalDue) ?? asNum(s.amountDue);
    if (total == null || total <= 0.5 || Math.abs(Number(s.amountDue ?? 0) - total) > 0.01) continue;
    if (asNum(raw.previousBalance) != null && Math.abs(asNum(raw.previousBalance)!) > 0.005) continue;
    const c = await carriedInto(s.utilityAccountId, s.statementDate, s.id);
    if (!c || c.carried <= 0.5) continue;
    const charge = r2(total - c.carried);
    if (charge <= 0.5) continue;
    await db.statement.update({
      where: { id: s.id },
      data: {
        amountDue: charge, chargesExcludingFees: charge, pastDueCarried: c.carried, balance: total,
        rawDataJson: { ...raw, statedTotalDue: total, previousBalance: c.carried, currentCharges: charge, pastDue: c.carried, totalDue: total, splitFromEmailTotal: true },
      },
    });
    fixed++;
  }
  return fixed;
}
