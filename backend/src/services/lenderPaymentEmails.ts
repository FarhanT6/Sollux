/**
 * A loan paid online: the servicer's "Thank you for your payment" / "Payment confirmation" /
 * "Your payment has been scheduled" email. It names the amount, the payment date, a confirmation
 * number and usually the loan number's last 4 — but no Zelle or Venmo, so the "you sent money"
 * reader (outgoingP2PEmails.ts) passed it by, and the inbox skipped it as a receipt. Loans paid on
 * the servicer's website had to be logged by hand every month.
 *
 * Read without Claude (patterns only), every few minutes with the other money emails. The loan is
 * the one whose lender the sender is — the sender's name or address, the lender's payment site's
 * address, or the name in the email — or whose loan number ends as the email's does. Logged when
 * sure: one such loan, and the amount within a dollar of its payment or the loan number matching
 * too; a payment of the same amount already on the loan within five days is that one, not a
 * second. A payment scheduled for a later day is logged on that day and, with the account it comes
 * from known, held as pending there until the bank shows it. Not sure: waits under Finances → Loans
 * → Payments to check when the account it is paid from is known, else noted in the inbox log.
 */
import { db } from '../config/db';
import { logLoanPaymentFromTransaction, periodFor } from './loanPaymentMatcher';
import { pendingForLoanPayment } from './pendingMoney';

export interface LenderPayment {
  sender: string; senderDomain: string | null; amount: number; date: Date; scheduled: boolean;
  confirmation: string | null; loanLast4: string | null; fromLast4: string | null; text: string;
}

const DAY = 86_400_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// A payment made or set up — not a reminder, a statement, a failure or a change of settings.
const PAID = /thank(?:s| you) for (?:your|the|making (?:a|your)) (?:online )?payment|your (?:online )?(?:[a-z]+ )?payment (?:is|has been) scheduled|your scheduled payment|payment (?:confirmation|received|processed|posted|successful|submitted|scheduled|is scheduled|has been (?:received|processed|scheduled|submitted|posted|made)|was (?:received|processed|scheduled|successful))|we(?:'ve| have) received your payment|your (?:online )?payment (?:of|for) \$|received your payment|confirmation of (?:your )?payment/i;
const NOT_PAID = /reminder|is due|due (?:soon|on|date)|upcoming|past due|statement|returned|failed|unsuccessful|declined|cancel(?:l)?ed|could not|unable|insufficient|autopay (?:enroll|is (?:now )?(?:on|set))|enrollment|change(?:d)? to your|escrow analysis|payoff/i;

function parseDate(raw: string): Date | null {
  const num = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw);
  let y: number, m: number, d: number;
  if (num) { m = +num[1] - 1; d = +num[2]; y = +num[3] < 100 ? 2000 + +num[3] : +num[3]; }
  else {
    const w = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(raw);
    if (!w) return null;
    m = MONTHS.indexOf(w[1].slice(0, 3).toLowerCase()); d = +w[2]; y = +w[3];
  }
  if (m < 0 || m > 11 || d < 1 || d > 31 || y < 2000) return null;
  return new Date(Date.UTC(y, m, d));
}
const DATE = '((?:\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})|(?:[A-Za-z]{3,9}\\.? \\d{1,2},? \\d{4}))';

/** The payment in a servicer's payment email, or null when the email is not one. */
export function parseLenderPaymentEmail(from: string, subject: string, body: string, receivedAt: Date | null): LenderPayment | null {
  const head = `${subject}\n${body.slice(0, 600)}`;
  if (!PAID.test(head) || NOT_PAID.test(subject)) return null;
  // Zelle / Venmo / Cash App / PayPal have their own readers.
  if (/zelle|venmo|cash ?app|paypal|apple cash/i.test(`${from} ${subject}`)) return null;
  const text = `${subject}\n${body.slice(0, 6000)}`;
  const amountM = /(?:payment amount|amount paid|total (?:payment )?amount|payment total|amount)\s*:?\s*\$\s?([\d,]+\.\d{2})/i.exec(text)
    ?? /payment (?:of|for)\s*\$\s?([\d,]+\.\d{2})/i.exec(text)
    ?? /\$\s?([\d,]+\.\d{2})\s+(?:payment|has been|was|is scheduled)/i.exec(text);
  const amount = amountM ? Number(amountM[1].replace(/,/g, '')) : 0;
  if (!(amount > 0)) return null;

  const when = new RegExp(`(?:scheduled (?:payment )?(?:date|for|on)|payment (?:effective |processing |scheduled |post |posting |draft )?date|post(?:ing)? date|effective date|date (?:paid|of payment|processed)|processed on|paid on|posted (?:to your account )?on|draft date|will be (?:debited|drafted|processed) on|\\bon)\\s*:?\\s*${DATE}`, 'i').exec(text);
  const local = receivedAt ? receivedAt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) : null;
  const received = local ? new Date(`${local}T00:00:00Z`) : null;
  const date = (when ? parseDate(when[1]) : null) ?? received;
  if (!date) return null;
  const scheduled = /scheduled|will be (?:debited|drafted|processed)/i.test(text) && !!received && date.getTime() > received.getTime();

  const confRe = /(?:confirmation|reference|transaction|trace)\s*(?:number|no\.?|#|id|code)?\s*:?\s*#?\s*([A-Za-z0-9-]{5,40})/gi;
  let confirmation: string | null = null;
  for (let m; (m = confRe.exec(text)); ) if (/\d/.test(m[1])) { confirmation = m[1]; break; }
  // "Loan number: ****1234"; and every "ending in 1234": the bank account it was paid from when the
  // words before it say so ("Wells Fargo Bank NA account ending in 0705"), else the account paid.
  let loanLast4 = /loan\s*(?:number|no\.?|#|account)\s*(?:ending(?: in| with)?)?\s*:?\s*[*xX•.…\s]*(\d{4})\b/i.exec(text)?.[1] ?? null;
  let fromLast4: string | null = null;
  for (const m of text.matchAll(/ending(?: in| with)?\s*:?\s*[*xX•.…\s]*(\d{4})\b/gi)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0);
    if (/bank|checking|savings|paid from|from your|funding/i.test(before)) fromLast4 ??= m[1];
    else loanLast4 ??= m[1];
  }

  const name = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim() ?? '';
  const domain = /@([\w.-]+)/.exec(from)?.[1]?.toLowerCase() ?? null;
  return { sender: name, senderDomain: domain, amount, date, scheduled, confirmation, loanLast4, fromLast4: fromLast4 !== loanLast4 ? fromLast4 : null, text };
}

const STOP = new Set(['inc', 'llc', 'co', 'corp', 'company', 'the', 'of', 'and', 'na', 'services', 'service', 'servicing', 'mortgage', 'loan', 'loans', 'bank', 'trust', 'trustee', 'financial', 'home', 'lending', 'no', 'reply', 'noreply', 'notifications', 'alerts', 'customer', 'care']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w));
/** "carringtonms.com" ← "mail.carringtonms.com"; the part that names the company. */
const baseDomain = (host: string | null) => (host ? host.split('.').slice(-2).join('.') : null);
const hostOf = (url: string | null) => { try { return url ? new URL(url).hostname.toLowerCase() : null; } catch { return null; } };

export interface LenderMatch { loanId: string; lender: string; expected: number; diff: number; nameHit: boolean; last4Hit: boolean; payFromBankAccountId: string | null; dueDay: number | null }

/** The owner's loans this email could be about, likeliest first. */
export async function lenderCandidates(userId: string, p: LenderPayment): Promise<LenderMatch[]> {
  const loans = await db.loan.findMany({
    where: { userId, isActive: true, utilityAccountId: null },
    select: { id: true, lender: true, monthlyPayment: true, escrowAmount: true, accountLast4: true, paymentUrl: true, payFromBankAccountId: true, dueDay: true },
  });
  const senderWords = new Set([...words(p.sender), ...words((p.senderDomain ?? '').replace(/\.(com|net|org|us|biz)$/, '').replace(/\./g, ' '))]);
  const bodyLower = p.text.toLowerCase();
  const out: LenderMatch[] = [];
  for (const l of loans) {
    const lw = words(l.lender);
    const site = baseDomain(hostOf(l.paymentUrl));
    const nameHit = (lw.length > 0 && lw.some(w => senderWords.has(w) || (w.length >= 5 && (p.senderDomain ?? '').includes(w))))
      || (!!site && baseDomain(p.senderDomain) === site)
      || (lw.length > 0 && lw.every(w => bodyLower.includes(w)));
    const last4Hit = !!p.loanLast4 && !!l.accountLast4 && l.accountLast4.replace(/\D/g, '').slice(-4) === p.loanLast4;
    if (!nameHit && !last4Hit) continue;
    const expected = Number(l.monthlyPayment ?? 0) + Number(l.escrowAmount ?? 0);
    out.push({ loanId: l.id, lender: l.lender, expected, diff: Math.abs(expected - p.amount), nameHit, last4Hit, payFromBankAccountId: l.payFromBankAccountId, dueDay: l.dueDay });
  }
  return out.sort((a, b) => Number(b.last4Hit) - Number(a.last4Hit) || Number(b.nameHit) - Number(a.nameHit) || a.diff - b.diff);
}

/** The one loan the email is surely for. */
export function sureLender(c: LenderMatch[]): LenderMatch | null {
  // The loan number and the lender both: whatever the amount (a payment with a late fee, or extra principal).
  const both = c.filter(x => x.last4Hit && x.nameHit);
  if (both.length === 1) return both[0];
  const exact = c.filter(x => x.expected > 0 && x.diff <= 1);
  return exact.length === 1 ? exact[0] : null;
}

export interface LenderResult { outcome: 'loan' | 'review' | 'skipped'; detail: string }

export async function recordLenderPayment(userId: string, p: LenderPayment, ref: string): Promise<LenderResult> {
  const key = `email:${ref}`;
  if (await db.outgoingTransaction.findUnique({ where: { plaidTransactionId: key }, select: { id: true } })) return { outcome: 'skipped', detail: 'payment email already read' };
  const cands = await lenderCandidates(userId, p);
  const money = `$${p.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const who = p.sender || p.senderDomain || 'the lender';
  if (!cands.length) return { outcome: 'skipped', detail: `${money} payment confirmed by ${who} — no loan of yours is with them` };
  const banks = p.fromLast4 ? await db.bankAccount.findMany({ where: { userId, last4: p.fromLast4, accountType: { not: 'CREDIT_CARD' } }, select: { id: true } }) : [];
  const sure = sureLender(cands);
  const pick = sure ?? cands[0];
  const bankAccountId = banks.length === 1 ? banks[0].id : pick.payFromBankAccountId;
  const name = `Online payment to ${pick.lender}${p.confirmation ? ` · conf ${p.confirmation}` : ''}${p.scheduled ? ' · scheduled' : ''}`.slice(0, 300);
  const day = p.date.toISOString().slice(0, 10);

  let paymentId: string | null = null;
  if (sure) {
    const before = await db.loanPayment.count({ where: { loanId: sure.loanId } });
    paymentId = await logLoanPaymentFromTransaction({ id: key, name, amount: p.amount, date: p.date }, sure.loanId, userId, {
      periodMonth: periodFor(p.date, sure.dueDay),
      notes: `Paid online (${who} email${p.scheduled ? `, scheduled for ${day}` : ''})${p.confirmation ? `, confirmation ${p.confirmation}` : ''}`,
    });
    const isNew = (await db.loanPayment.count({ where: { loanId: sure.loanId } })) > before;
    // Not out of the account yet: pending there until the bank shows it.
    if (isNew && bankAccountId && (p.scheduled || Date.now() - p.date.getTime() < 3 * DAY)) {
      const lp = await db.loanPayment.findUnique({ where: { id: paymentId }, select: { id: true, amount: true, date: true, method: true, confirmationNumber: true } });
      if (lp) await pendingForLoanPayment(userId, bankAccountId, { id: lp.id, amount: Number(lp.amount), date: lp.date, method: lp.method ?? 'ONLINE', confirmationNumber: p.confirmation }, sure.lender).catch(() => null);
    }
    if (p.confirmation && isNew) await db.loanPayment.update({ where: { id: paymentId }, data: { confirmationNumber: p.confirmation, method: 'ONLINE' } }).catch(() => {});
  }
  if (bankAccountId) {
    await db.outgoingTransaction.create({
      data: {
        userId, bankAccountId, plaidTransactionId: key, amount: p.amount, date: p.date, name, matchType: 'LOAN', loanId: pick.loanId,
        status: paymentId ? 'APPLIED' : 'SUGGESTED', ...(paymentId ? { appliedType: 'LOAN_PAYMENT', appliedId: paymentId } : {}),
      },
    }).catch(() => {});
  }
  if (paymentId) return { outcome: 'loan', detail: `${money} paid online to ${pick.lender}${p.scheduled ? ` (scheduled for ${day})` : ''} logged${p.confirmation ? ` (conf ${p.confirmation})` : ''}` };
  return bankAccountId
    ? { outcome: 'review', detail: `${money} paid online — maybe the ${pick.lender} loan (${pick.expected ? `its payment is $${pick.expected.toFixed(2)}` : 'no payment amount on file'}); waiting under Finances → Loans → Payments to check` }
    : { outcome: 'review', detail: `${money} paid online — maybe the ${pick.lender} loan, but not sure: if it was, log it on the loan under Finances → Loans` };
}
