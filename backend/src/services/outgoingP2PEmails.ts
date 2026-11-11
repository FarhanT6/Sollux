/**
 * Money the owner sent by Zelle, Venmo, Cash App or PayPal, read from the
 * "You sent $8,333.33 to …" email the minute it goes out — a loan paid to a
 * private lender most often. The email has what the bank line lacks: the
 * confirmation number and the memo ("1016 Example St November 2026 Payment"),
 * which names the property and the month.
 *
 * The payee is matched to a loan's lender (findLoanCandidates); the memo's
 * address picks between a lender's loans, or finds the loan when the lender's
 * name is not the one on file. A sure match — one loan, the amount within a
 * dollar of its payment — is logged as that month's payment (the memo's month,
 * else the due date it lands nearest), once: a payment already on the loan
 * within five days is linked, not doubled. A likelier-than-not match waits in
 * Expense Payments; anything else is only noted in the inbox log. When the
 * bank later shows the same debit, it takes over the email's row instead of
 * adding a second (transactionMatchService, emailTwin).
 */
import { db } from '../config/db';
import { channelOf, cleanName, dateFrom, memoMonth, type P2PChannel } from './p2pPaymentEmails';
import { findLoanCandidates, logLoanPaymentFromTransaction, type LoanCandidate } from './loanPaymentMatcher';
import { propertyScore } from '../lib/managerStatementMatch';

export interface OutgoingP2P {
  channel: P2PChannel; payee: string; amount: number; date: Date;
  confirmation: string | null; fromLast4: string | null; memo: string | null;
}

const DAY = 86_400_000;
const money = (s: string) => Number(s.replace(/[,\s]/g, ''));
// Sent, not asked for, scheduled, failed or cancelled.
const NOT_SENT = /\b(request(?:ed|s)?|scheduled|will be sent|pending|on hold|declined|failed|cancel(?:l)?ed|unable|reminder)\b/i;
const LABEL = { ZELLE: 'Zelle', VENMO: 'Venmo', PAYPAL: 'PayPal', CASH_APP: 'Cash App', APPLE_CASH: 'Apple Cash' } as const;

/** The payment in a "you sent money" email, or null when the email is not one. */
export function parseOutgoingP2P(from: string, subject: string, body: string, receivedAt: Date | null): OutgoingP2P | null {
  const channel = channelOf(from, subject, body);
  if (!channel) return null;
  const text = `${subject}\n${body.slice(0, 4000)}`;
  if (NOT_SENT.test(subject)) return null;
  let payee: string | null = null, amount = 0;
  // "You sent $8,333.33 to Mick Sample" (Zelle at the banks, Cash App), "You sent $50.00 USD to Sample Name" (PayPal).
  const sent = /\byou(?:'ve| have)?\s+sent\s+(?:a payment of\s+)?\$\s?([\d,]+(?:\.\d{2})?)(?:\s*USD)?\s+to\s+([^\n]{2,80})/i.exec(text);
  // "You paid Sample Name $50.00" (Venmo).
  const paid = /\b[Yy]ou\s+paid\s+([A-Z][^\n$]{1,60}?)\s+\$\s?([\d,]+(?:\.\d{2})?)/.exec(text);
  if (sent) {
    amount = money(sent[1]);
    payee = cleanName(sent[2].replace(/\s+(?:on|with|using|via|for|from)\b.*$/i, '').replace(/[.!].*$/, ''));
  } else if (paid) {
    amount = money(paid[2]);
    payee = cleanName(paid[1]);
  }
  if (!payee || !(amount > 0)) return null;

  const confRe = /(?:confirmation|transaction|reference|transfer)\s*(?:number|no\.?|#|id|code)?\s*:?\s*#?\s*([A-Za-z0-9-]{6,40})/gi;
  let confirmation: string | null = null;
  for (let m; (m = confRe.exec(body)); ) if (/\d/.test(m[1])) { confirmation = m[1]; break; }
  const last4 = /(?:from|sent from|paid from|funding)\s*(?:account|checking|savings)?\s*:?\s*(?:ending in\s*)?[.x*•…]*\s*(\d{4})\b/i.exec(body)
    ?? /(?:account|checking)\s*(?:ending in|ending|\.{2,}|x+|\*+|•+)\s*(\d{4})\b/i.exec(body);
  const memoM = /(?:^|\n)\s*(?:memo|note|message|for)\s*:?\s+["“]?([^\n"”]{1,100})/i.exec(body);
  const memo = memoM ? memoM[1].replace(/\s+(see (?:zelle|transaction)|didn'?t send|thank you)\b.*$/i, '').trim() || null : null;
  const local = receivedAt ? receivedAt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) : null;
  const date = dateFrom(body) ?? (local ? new Date(`${local}T00:00:00Z`) : null);
  if (!date) return null;
  return { channel, payee, amount, date, confirmation, fromLast4: last4?.[1] ?? null, memo };
}

export interface OutgoingResult { outcome: 'loan' | 'review' | 'skipped'; detail: string }

/** The loan an outgoing payment is for: by the lender's name, else the memo's address and the amount. */
async function loansFor(userId: string, p: OutgoingP2P, bankAccountId: string | null): Promise<{ cands: (LoanCandidate & { addressHit: boolean })[]; sure: (LoanCandidate & { addressHit: boolean }) | null }> {
  const byName = (await findLoanCandidates(p.payee, p.amount, userId, bankAccountId)).filter(c => c.nameHit || c.fromAccount);
  const loans = await db.loan.findMany({
    where: { userId, isActive: true },
    select: { id: true, lender: true, propertyId: true, monthlyPayment: true, escrowAmount: true, dueDay: true, paymentMethods: true, payFromBankAccountId: true, property: { select: { address: true, nickname: true } } },
  });
  const addressHit = (loanId: string) => {
    const l = loans.find(x => x.id === loanId);
    return !!(p.memo && l?.property && propertyScore(p.memo, l.property) > 0);
  };
  let cands = byName.map(c => ({ ...c, addressHit: addressHit(c.loanId) }));
  // The memo names the property: among the lender's loans, that one; with no name on file, the loan on that property paid this amount.
  if (cands.length > 1 && cands.some(c => c.addressHit)) cands = cands.filter(c => c.addressHit);
  if (!cands.length && p.memo) {
    cands = loans.filter(l => addressHit(l.id)).map(l => {
      const expected = Number(l.monthlyPayment ?? 0) + Number(l.escrowAmount ?? 0);
      return { loanId: l.id, lender: l.lender, propertyId: l.propertyId, expected, diff: Math.abs(expected - p.amount), nameHit: false, fromAccount: !!bankAccountId && l.payFromBankAccountId === bankAccountId, dueDay: l.dueDay, paymentMethods: l.paymentMethods, addressHit: true };
    }).filter(c => c.expected > 0 && c.diff <= 1);
  }
  const exact = cands.filter(c => c.expected > 0 && c.diff <= 1 && (c.nameHit || c.fromAccount || c.addressHit));
  return { cands, sure: exact.length === 1 ? exact[0] : null };
}

/** Record a "you sent money" email: a loan payment when it is surely one, a suggestion when it may be, else nothing. */
export async function recordOutgoingP2P(userId: string, p: OutgoingP2P, ref: string): Promise<OutgoingResult> {
  const key = `email:${ref}`;
  if (await db.outgoingTransaction.findUnique({ where: { plaidTransactionId: key }, select: { id: true } })) return { outcome: 'skipped', detail: 'payment email already read' };
  const banks = p.fromLast4 ? await db.bankAccount.findMany({ where: { userId, last4: p.fromLast4, accountType: { not: 'CREDIT_CARD' } }, select: { id: true } }) : [];
  const bankAccountId = banks.length === 1 ? banks[0].id : null;
  const { cands, sure } = await loansFor(userId, p, bankAccountId);
  const sentTo = `${LABEL[p.channel]} to ${p.payee}`;
  const name = `${sentTo}${p.confirmation ? ` · conf ${p.confirmation}` : ''}${p.memo ? ` · ${p.memo}` : ''}`.slice(0, 300);
  const money2 = `$${p.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (!cands.length) return { outcome: 'skipped', detail: `sent ${money2} by ${sentTo} — not a loan payment Sollux knows (no loan from ${p.payee}${p.memo ? ' or for that address' : ''})` };

  // The month it pays: the memo's ("November 2026 Payment"), else the due date it lands nearest.
  const month = memoMonth(p.date, p.memo);
  let paymentId: string | null = null;
  if (sure) {
    paymentId = await logLoanPaymentFromTransaction({ id: key, name, amount: p.amount, date: p.date }, sure.loanId, userId, {
      periodMonth: month ? month.toISOString().slice(0, 7) : null,
      notes: `${sentTo} (email)${p.confirmation ? `, confirmation ${p.confirmation}` : ''}${p.memo ? ` — "${p.memo}"` : ''}`,
    });
  }
  const pick = sure ?? cands[0];
  // A row to review (or the record of what was logged) needs the account the money left; the bank's line fills it in later otherwise.
  if (bankAccountId) {
    await db.outgoingTransaction.create({
      data: {
        userId, bankAccountId, plaidTransactionId: key, amount: p.amount, date: p.date, name, matchType: 'LOAN', loanId: pick.loanId, propertyId: pick.propertyId,
        status: paymentId ? 'APPLIED' : 'SUGGESTED', ...(paymentId ? { appliedType: 'LOAN_PAYMENT', appliedId: paymentId } : {}),
      },
    });
  }
  if (paymentId) return { outcome: 'loan', detail: `${money2} ${sentTo} logged on the ${pick.lender} loan${month ? ` for ${month.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}` : ''}${p.confirmation ? ` (conf ${p.confirmation})` : ''}` };
  return bankAccountId
    ? { outcome: 'review', detail: `${money2} ${sentTo} — maybe the ${pick.lender} loan (${pick.expected ? `its payment is $${pick.expected.toFixed(2)}` : 'no payment amount on file'}); waiting in Expense Payments` }
    : { outcome: 'skipped', detail: `${money2} ${sentTo} — maybe the ${pick.lender} loan, but not sure${p.fromLast4 ? ` and account ··${p.fromLast4} is not in Sollux` : ''}: log it on the loan if it was` };
}

/**
 * The bank's line for money already read from its "you sent" email: the email's row takes the bank's id
 * (so the debit is not a second payment), and is applied now when it waited and the bank's match is sure.
 */
export async function emailTwin(userId: string, bankAccountId: string, amount: number, date: Date) {
  return db.outgoingTransaction.findFirst({
    where: {
      userId, bankAccountId, plaidTransactionId: { startsWith: 'email:' },
      amount: { gte: amount - 0.005, lte: amount + 0.005 },
      date: { gte: new Date(date.getTime() - 5 * DAY), lte: new Date(date.getTime() + 2 * DAY) },
    },
    orderBy: { date: 'asc' },
  });
}
