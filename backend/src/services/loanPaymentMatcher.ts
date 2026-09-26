/**
 * The payment matcher, loans side: a debit on the owner's bank account that
 * is a loan payment — "CARRINGTON MTG PMT 5,464.35", "RUSHMORE LOAN SVC",
 * an autopay out of the account a loan is paid from — becomes a payment in
 * the loan tracker, for the month whose due date it answers.
 *
 * Confident matches (the lender's name in the descriptor and the amount
 * within a dollar of the monthly payment, one loan only) are logged on their
 * own; anything less waits in Expense Payments for a click. A payment already
 * logged by hand for that loan within five days is linked, not doubled.
 */
import { db } from '../config/db';

const DAY = 86400000;
const STOP = new Set(['the', 'of', 'and', 'trust', 'trustee', 'family', 'living', 'revocable', 'inc', 'llc', 'corp', 'co', 'services', 'service',
  'servicing', 'financial', 'mortgage', 'mtg', 'home', 'loan', 'loans', 'bank', 'payment', 'pmt', 'pymt', 'online', 'ach', 'debit', 'web', 'ppd', 'id', 'autopay']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));

export interface LoanCandidate {
  loanId: string; lender: string; propertyId: string | null; expected: number; diff: number;
  nameHit: boolean; fromAccount: boolean; dueDay: number | null; paymentMethods: string[];
}

export async function findLoanCandidates(name: string, amount: number, userId: string, bankAccountId: string | null): Promise<LoanCandidate[]> {
  const tx = new Set(words(name));
  const loans = await db.loan.findMany({
    where: { userId, isActive: true },
    select: { id: true, lender: true, propertyId: true, monthlyPayment: true, escrowAmount: true, dueDay: true, paymentMethods: true, payFromBankAccountId: true },
  });
  const out: LoanCandidate[] = [];
  for (const l of loans) {
    const expected = Number(l.monthlyPayment ?? 0) + Number(l.escrowAmount ?? 0);
    const nameHit = words(l.lender).some(w => tx.has(w));
    const fromAccount = !!bankAccountId && l.payFromBankAccountId === bankAccountId;
    const diff = Math.abs(expected - amount);
    // The lender's name, or the loan's own pay-from account with the exact payment.
    if (nameHit || (fromAccount && expected > 0 && diff <= 1)) {
      out.push({ loanId: l.id, lender: l.lender, propertyId: l.propertyId, expected, diff, nameHit, fromAccount, dueDay: l.dueDay, paymentMethods: l.paymentMethods });
    }
  }
  return out.sort((a, b) => Number(b.nameHit) - Number(a.nameHit) || a.diff - b.diff);
}

/** The one loan a debit is surely for, or null when a person should decide. */
export function confidentLoan(cands: LoanCandidate[]): LoanCandidate | null {
  const exact = cands.filter(c => c.expected > 0 && c.diff <= 1 && (c.nameHit || c.fromAccount));
  return exact.length === 1 ? exact[0] : null;
}

/** The month a payment covers: the month whose due date it lands nearest. YYYY-MM. */
export function periodFor(date: Date, dueDay: number | null): string {
  let best = '', bestGap = Infinity;
  for (const shift of [-1, 0, 1]) {
    const y = date.getUTCFullYear(), m = date.getUTCMonth() + shift;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const due = Date.UTC(y, m, Math.min(dueDay ?? 1, last));
    // Paying a little early is normal; paying weeks late is less likely than paying for next month.
    const gap = Math.abs(date.getTime() - due) * (date.getTime() > due ? 1.3 : 1);
    if (gap < bestGap) { bestGap = gap; best = new Date(due).toISOString().slice(0, 7); }
  }
  return best;
}

export function methodFor(name: string, loanMethods: string[]): string {
  if (/zelle/i.test(name)) return 'ZELLE';
  if (/\bche?ck\b|\bchk\b/i.test(name)) return 'CHECK';
  if (/\bwire\b/i.test(name)) return 'WIRE';
  if (loanMethods.includes('AUTOPAY')) return 'AUTOPAY';
  return 'ONLINE';
}

/**
 * Log an outgoing bank transaction as a payment on a loan. Returns the loan
 * payment's id. If one was already logged by hand (same loan, within a dollar,
 * within five days), that one is returned and nothing is added.
 */
export async function logLoanPaymentFromTransaction(tx: { id: string; name: string; amount: unknown; date: Date }, loanId: string, userId: string): Promise<string> {
  const loan = await db.loan.findFirst({ where: { id: loanId, userId }, select: { id: true, dueDay: true, paymentMethods: true, monthlyPayment: true, escrowAmount: true } });
  if (!loan) throw new Error('Loan not found');
  const amount = Number(tx.amount);
  const near = await db.loanPayment.findFirst({
    where: { loanId, date: { gte: new Date(tx.date.getTime() - 5 * DAY), lte: new Date(tx.date.getTime() + 5 * DAY) }, amount: { gte: amount - 1, lte: amount + 1 } },
    select: { id: true },
  });
  if (near) return near.id;
  const period = periodFor(tx.date, loan.dueDay);
  const expected = Number(loan.monthlyPayment ?? 0) + Number(loan.escrowAmount ?? 0);
  const p = await db.loanPayment.create({
    data: {
      loanId, date: tx.date, amount, billAmount: expected > 0 ? expected : null, status: 'PAID',
      periodDate: new Date(`${period}-01T00:00:00.000Z`), method: methodFor(tx.name, loan.paymentMethods),
      notes: `From the bank: "${tx.name}"`,
    },
  });
  return p.id;
}
