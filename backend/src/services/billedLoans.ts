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
  return short.every(w => long.includes(w));
}

const PROPERTY_LOANS = ['MORTGAGE', 'HELOC', 'SELLER_FINANCING', 'DSCR', 'COMMERCIAL', 'HARD_MONEY', 'PERSONAL'];
const last4 = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '').slice(-4);

/** Links every such loan of one owner (or every owner). Returns the loans linked. */
export async function linkBilledLoans(userId?: string): Promise<{ loanId: string; utilityAccountId: string }[]> {
  const loans = await db.loan.findMany({
    where: { utilityAccountId: null, ...(userId ? { userId } : {}) },
    select: { id: true, userId: true, propertyId: true, lender: true, loanType: true, accountLast4: true },
  });
  const linked: { loanId: string; utilityAccountId: string }[] = [];
  for (const l of loans) {
    const accounts = await db.utilityAccount.findMany({
      where: { property: { userId: l.userId }, loan: null, escrowLoanId: null, ...(l.propertyId ? { propertyId: l.propertyId } : {}) },
      select: { id: true, providerName: true, category: true, accountNumber: true },
    });
    const fits = accounts.filter(a => sameCompany(a.providerName, l.lender)
      && (!PROPERTY_LOANS.includes(l.loanType) && l.loanType !== 'OTHER' || a.category === 'INSURANCE')
      && !(l.accountLast4 && last4(a.accountNumber) && last4(l.accountLast4) !== last4(a.accountNumber)));
    if (fits.length !== 1) continue;
    const r = await db.loan.updateMany({ where: { id: l.id, utilityAccountId: null }, data: { utilityAccountId: fits[0].id } }).catch(() => ({ count: 0 }));
    if (r.count) linked.push({ loanId: l.id, utilityAccountId: fits[0].id });
  }
  return linked;
}

const lastRun = new Map<string, number>();
/** linkBilledLoans for one owner, at most every 10 minutes (called where loans are listed). */
export async function linkBilledLoansSoon(userId: string): Promise<void> {
  const at = lastRun.get(userId) ?? 0;
  if (Date.now() - at < 10 * 60_000) return;
  lastRun.set(userId, Date.now());
  await linkBilledLoans(userId).catch(() => {});
}
