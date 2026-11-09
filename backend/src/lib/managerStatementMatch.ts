/**
 * Matching a manager's statement lines to the owner's records — pure, so it
 * is tested without a database. A property manager's monthly statement
 * names a property by its street address (or a nickname), a tenant by name
 * or unit, a lender by name; each is matched to the one record it plainly
 * means, or left for the owner to choose when two fit or none does.
 */

export type LineKind = 'RENT' | 'MANAGEMENT_FEE' | 'REPAIR' | 'UTILITY' | 'LOAN_PAYMENT' | 'OTHER_EXPENSE' | 'REIMBURSEMENT' | 'OWNER_PAYMENT' | 'OWNER_DRAW' | 'OTHER';

/** Kinds recorded as a property's cost (a reimbursement as a negative one, offsetting the cost it pays back). */
export const COST_KINDS: LineKind[] = ['MANAGEMENT_FEE', 'REPAIR', 'UTILITY', 'OTHER_EXPENSE', 'REIMBURSEMENT'];

/**
 * A line's wording as a key for what the owner chose for it before: lowercase, words and amounts kept
 * ("loan interest james $150k"), dates and punctuation dropped. Two lines with the same key are the same
 * kind of line every month.
 */
export function lineKey(description: string): string {
  return String(description ?? '').toLowerCase()
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b\.?(?:\s+\d{4})?/g, ' ')
    .replace(/[^a-z0-9$]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** What the owner chose for a line, remembered per manager (ReconciliationProfile.lineRules). */
export interface LineRule {
  kind: LineKind; propertyId?: string | null; leaseId?: string | null; loanId?: string | null; category?: string | null; bankAccountId?: string | null;
  /** A loan line that paid two loans at once ("Loan repayment - Colucci" when there were two Colucci loans): how a
   *  line of exactly this total was split. A different amount of the same line goes to loanId. */
  splits?: { total: number; parts: LoanSplit[] }[];
}
/** One loan's part of a line that paid several. */
export interface LoanSplit { loanId: string; amount: number }

const STOP = new Set(['the', 'and', 'of', 'llc', 'inc', 'co', 'st', 'street', 'rd', 'road', 'ave', 'avenue', 'dr', 'drive', 'ln', 'lane', 'way', 'blvd', 'ct', 'court', 'pl', 'unit', 'apt', 'suite', 'ste', 'n', 's', 'e', 'w', 'bank', 'mortgage', 'loan', 'servicing', 'financial']);

export function words(s: string | null | undefined): string[] {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
}

/** The house number of an address, when it starts with one. */
export const houseNumber = (s: string | null | undefined) => String(s ?? '').trim().match(/^(\d+)\b/)?.[1] ?? null;

/** How well a property hint names a property: the house number and a street word, or the nickname. 0 when it does not. */
export function propertyScore(hint: string, p: { address: string; nickname: string | null }): number {
  const h = words(hint);
  if (!h.length) return 0;
  const num = houseNumber(hint);
  if (num && houseNumber(p.address) === num) {
    const street = words(p.address).filter(w => w !== num);
    if (street.some(w => h.includes(w))) return 3;
  }
  const nick = words(p.nickname);
  if (nick.length && nick.every(w => h.includes(w))) return 2;
  return 0;
}

/** How well a tenant/unit hint names a lease: every word of a tenant's name, or the unit label within its property. */
export function leaseScore(hint: string, l: { tenantNames: string[]; unitLabel: string }): number {
  const h = words(hint);
  if (!h.length) return 0;
  for (const name of l.tenantNames) {
    const n = words(name);
    if (n.length && n.every(w => h.includes(w))) return 3;
    // A last name alone ("Alvarez, rent") still points at one tenant.
    if (n.length > 1 && h.includes(n[n.length - 1])) return 1;
  }
  const unit = words(l.unitLabel);
  if (unit.length && unit.every(w => h.includes(w))) return 2;
  return 0;
}

export function lenderScore(hint: string, lender: string): number {
  const h = words(hint), l = words(lender);
  if (!h.length || !l.length) return 0;
  const hits = l.filter(w => h.includes(w)).length;
  return hits === l.length ? 2 : hits > 0 ? 1 : 0;
}

/** Words that say a line is a loan payment without saying whose ("Loan repayment", "Mortgage interest"). */
const LOAN_WORDS = new Set(['repayment', 'repay', 'payment', 'payments', 'pmt', 'interest', 'principal', 'escrow', 'monthly', 'note', 'installment', 'to', 'for', 'from', 'paid', 'private', 'lender', 'refinance', 'heloc']);
/** Whether a loan line names someone (a lender or a person): "Loan repayment - Colucci" does, "Mortgage payment" does not. */
export function namesSomeone(hint: string): boolean {
  return words(hint).some(w => w.length > 1 && !LOAN_WORDS.has(w) && !/^\d/.test(w));
}

/**
 * The loan a loan line pays. A lender named on the line decides: one on the line's property first, then any
 * of the owner's loans (a private loan often has no property on file). Being on the manager's list of loans
 * only breaks a tie between named ones — it never picks a loan alone: "Loan repayment - Paul" went to the
 * manager's other lender's loan because that one was on the list. A line that names no one is the
 * property's only loan; otherwise it waits for the owner to choose (and the choice is remembered).
 */
export function pickLoan<T extends { id: string; lender: string; propertyId: string | null }>(hint: string, loans: T[], o: { propertyId: string | null; mine: string[] }): T | null {
  const score = (x: T) => { const n = lenderScore(hint, x.lender); return n > 0 ? n * 2 + (o.mine.includes(x.id) ? 1 : 0) : 0; };
  const here = loans.filter(x => !o.propertyId || !x.propertyId || x.propertyId === o.propertyId);
  const named = best(here, score) ?? (here.length < loans.length ? best(loans, score) : null);
  if (named) return named;
  if (namesSomeone(hint)) return null;
  const own = o.propertyId ? loans.filter(x => x.propertyId === o.propertyId) : loans;
  return own.length === 1 ? own[0] : null;
}

/** The one best candidate, or null when none fits or two fit equally well. */
export function best<T>(items: T[], score: (t: T) => number): T | null {
  let top: T | null = null, topScore = 0, tie = false;
  for (const t of items) {
    const s = score(t);
    if (s > topScore) { top = t; topScore = s; tie = false; }
    else if (s === topScore && s > 0) tie = true;
  }
  return topScore > 0 && !tie ? top : null;
}

/** Which expense category a cost line is filed under. */
export function categoryFor(kind: LineKind): string | null {
  switch (kind) {
    case 'MANAGEMENT_FEE': return 'PROPERTY_MANAGEMENT';
    case 'REPAIR': return 'REPAIRS_MAINTENANCE';
    case 'UTILITY': return 'UTILITIES';
    case 'OTHER_EXPENSE': return 'OTHER';
    default: return null;
  }
}
