/**
 * A loan that is the same debt as one of the owner's accounts — a premium finance agreement whose
 * installments are the insurance account's bills, a solar loan billed monthly — belongs to that
 * account (loans.utilityAccountId): it then lives on the account, is left off the Bills page's loan
 * rows and the Loans tab, and the costs count the bills once. The importer links the loans it makes;
 * one entered by hand, or left behind when its account was deleted and added again (the link is
 * cleared then), stood beside the account as a second "Capital Premium Financing" row, read late
 * every month because the payments are on the account, and counted again in costs.
 *
 * Linked when one account of the owner's (on the loan's property, when it has one) carries the
 * lender's name, has no loan of its own, and nothing says otherwise (a different last 4). A mortgage
 * or private note is only linked to an insurance account (premium financing): its own statement
 * account is not where it should live.
 */
import { db } from '../config/db';

const STOP = new Set(['inc', 'llc', 'co', 'corp', 'corporation', 'company', 'the', 'of', 'and', 'ltd', 'lp', 'na']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));

/** The same company by name: every word of the shorter name in the longer one, two words at least (or one long word). */
export function sameCompany(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length === 1 && short[0].length < 5) return false;
  // "Finance" and "Financing" are one word: the same first six letters of a long word.
  const same = (a: string, b: string) => a === b || (a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6));
  return short.every(w => long.some(v => same(w, v)));
}

const PROPERTY_LOANS = ['MORTGAGE', 'HELOC', 'SELLER_FINANCING', 'DSCR', 'COMMERCIAL', 'HARD_MONEY', 'PERSONAL'];
const last4 = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '').slice(-4);

const n = (v: unknown) => (v == null ? 0 : Number(v));

export interface BilledLoanChange { loanId: string; utilityAccountId: string; kind: 'linked' | 'set-aside'; duplicateOf?: string }

/**
 * Links every such loan of one owner (or every owner) to its account. When the account already has
 * its loan — the importer makes one when it reads the premium finance agreement — a loan entered
 * apart for the same debt (the same payment, or the same loan number) is set aside instead
 * (inactive, with a note), its payments moved to the account's loan: it was the second "Capital
 * Premium Financing" row. A premium finance account carries the policy's or the agreement's number
 * and the loan its own, so on an insurance account, the only one of that company on the property,
 * a different last 4 does not stop the link.
 */
export async function linkBilledLoans(userId?: string): Promise<BilledLoanChange[]> {
  const loans = await db.loan.findMany({
    where: { utilityAccountId: null, isActive: true, ...(userId ? { userId } : {}) },
    select: { id: true, userId: true, propertyId: true, lender: true, loanType: true, accountLast4: true, monthlyPayment: true, notes: true },
  });
  const changes: BilledLoanChange[] = [];
  for (const l of loans) {
    const accounts = await db.utilityAccount.findMany({
      where: { property: { userId: l.userId }, escrowLoanId: null, ...(l.propertyId ? { propertyId: l.propertyId } : {}) },
      select: { id: true, providerName: true, category: true, accountNumber: true, loan: { select: { id: true, monthlyPayment: true, accountLast4: true } } },
    });
    const fits = accounts.filter(a => sameCompany(a.providerName, l.lender)
      && (!PROPERTY_LOANS.includes(l.loanType) && l.loanType !== 'OTHER' || a.category === 'INSURANCE'));
    if (fits.length !== 1) continue;
    const a = fits[0];
    if (!a.loan) {
      if (l.accountLast4 && last4(a.accountNumber) && last4(l.accountLast4) !== last4(a.accountNumber) && a.category !== 'INSURANCE') continue;
      const r = await db.loan.updateMany({ where: { id: l.id, utilityAccountId: null }, data: { utilityAccountId: a.id } }).catch(() => ({ count: 0 }));
      if (r.count) changes.push({ loanId: l.id, utilityAccountId: a.id, kind: 'linked' });
      continue;
    }
    // The account has its loan: this one is the same debt entered again, or another agreement (left alone).
    const samePayment = n(l.monthlyPayment) > 0 && Math.abs(n(l.monthlyPayment) - n(a.loan.monthlyPayment)) <= 1;
    const sameNumber = !!l.accountLast4 && !!a.loan.accountLast4 && last4(l.accountLast4) === last4(a.loan.accountLast4);
    if (!samePayment && !sameNumber) continue;
    const target = a.loan.id;
    // Its payments go to the account's loan, unless that one has the same payment already.
    for (const p of await db.loanPayment.findMany({ where: { loanId: l.id } })) {
      const twin = await db.loanPayment.findFirst({
        where: { loanId: target, amount: { gte: n(p.amount) - 0.5, lte: n(p.amount) + 0.5 }, date: { gte: new Date(p.date.getTime() - 3 * 86_400_000), lte: new Date(p.date.getTime() + 3 * 86_400_000) } },
        select: { id: true },
      });
      if (twin) await db.loanPayment.delete({ where: { id: p.id } });
      else await db.loanPayment.update({ where: { id: p.id }, data: { loanId: target } });
    }
    const where = `${a.providerName}${last4(a.accountNumber) ? ` ··${last4(a.accountNumber)}` : ''}`;
    await db.loan.update({
      where: { id: l.id },
      data: { isActive: false, notes: `${l.notes ? `${l.notes}\n` : ''}Set aside by Sollux: the same debt as the loan billed on ${where}, which keeps its payments.`.slice(0, 2000) },
    });
    changes.push({ loanId: l.id, utilityAccountId: a.id, kind: 'set-aside', duplicateOf: target });
  }
  return changes;
}

const lastRun = new Map<string, number>();
/** linkBilledLoans for one owner, at most every 10 minutes (called where loans are listed). */
export async function linkBilledLoansSoon(userId: string): Promise<void> {
  const at = lastRun.get(userId) ?? 0;
  if (Date.now() - at < 10 * 60_000) return;
  lastRun.set(userId, Date.now());
  await linkBilledLoans(userId).catch(() => {});
}
