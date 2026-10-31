/**
 * Money received through Zelle, Venmo, Cash App, PayPal or Apple Cash, read
 * from the app's or the bank's notification email ("JACOB ADAMS sent you
 * $4,452.00"). The email names the payer, the amount, the date, a
 * confirmation number and often the account it went into; that is enough to
 * put it in the Incoming Payments queue next to the bank feed's transfers.
 *
 * Read with patterns, not Claude: these emails are short and regular, and
 * every one would otherwise be a paid read.
 *
 * A payment is logged on its own only when the payer is plainly one tenant
 * (a payer name the owner entered, or the tenant's whole name) and nothing in
 * the memo says it is for something other than rent. Everything else waits in
 * Finances -> Incoming for the owner to pick the tenant, apply or ignore.
 */
import { db } from '../config/db';
import { recordRentPayment, periodStartOf } from './rentPaymentService';
import { matchLease, matchLeaseByAmount, CHANNEL_TO_METHOD } from './transactionMatchService';

export type P2PChannel = 'ZELLE' | 'VENMO' | 'PAYPAL' | 'CASH_APP' | 'APPLE_CASH';

export interface P2PPayment {
  channel: P2PChannel;
  payer: string;
  amount: number;
  /** The day the money was sent, as a UTC midnight date (same as Plaid's dates). */
  date: Date;
  confirmation: string | null;
  depositLast4: string | null;
  memo: string | null;
}

const DAY = 24 * 3600 * 1000;
// Money coming in. "You sent", "you paid", "requested" and "request from" are money going out or asked for.
const INCOMING = /\b(sent you|paid you|you(?:'ve| have)? received|you've got money|you got paid|you've been paid|money (?:is )?(?:on its way|deposited)|deposited (?:in|to|into) your)\b/i;
const OUTGOING = /\byou (?:sent|paid|requested)\b|\brequests?\b|\brequested\b|\bscheduled\b|\bdeclined\b|\bcancel(?:l)?ed\b|\bfailed\b|\bpending your\b/i;
// Words that are never part of the payer's name.
const NOT_NAME = new Set(['hi', 'hello', 'dear', 'good', 'news', 'great', 'you', 'your', 'zelle', 'venmo', 'cash', 'app', 'paypal', 'apple', 'from', 'has', 'have', 'the', 'and', 're', 'fwd', 'fw']);
// A memo that says the money is for something other than rent: left for the owner.
const NOT_RENT = /util|water|electric|power|\bgas\b|sewer|trash|internet|wifi|reimburs|deposit|repair|fee\b|refund/i;

/**
 * Whether a payment is logged as rent without asking — the same rule for
 * an email and the bank feed. It has to be certain it is rent: the sender is
 * the tenant (their whole name, a saved payer name, or most of their name),
 * the amount is no more than they owe (this month's rent plus arrears), and
 * no memo says it is for something else. A match by amount alone, anything
 * over what is owed (a deposit, two months, a utility on top) or a memo like
 * "water" or "deposit" waits for review, even from a saved payer.
 */
export function sureOfTenant(
  nameMatch: { viaAlias: boolean; exact: boolean } | null,
  lease: { rentAmount: unknown; arrearsBalance: unknown } | null,
  amount: number, memo: string | null | undefined,
): boolean {
  if (!nameMatch || !lease || !(amount > 0)) return false;
  const owed = Number(lease.rentAmount) + Number(lease.arrearsBalance ?? 0);
  if (amount > owed + 0.005) return false;
  if (memo && NOT_RENT.test(memo)) return false;
  return true;
}

function channelOf(from: string, subject: string, body: string): P2PChannel | null {
  const f = from.toLowerCase();
  if (/venmo\.com/.test(f)) return 'VENMO';
  if (/cash\.app|square(up)?\.com/.test(f)) return 'CASH_APP';
  if (/paypal\.com/.test(f)) return 'PAYPAL';
  const text = `${subject}\n${body.slice(0, 3000)}`;
  if (/zelle/i.test(text)) return 'ZELLE';
  if (/apple cash/i.test(text) && /apple\.com/.test(f)) return 'APPLE_CASH';
  if (/venmo/i.test(subject)) return 'VENMO';
  if (/cash ?app/i.test(subject)) return 'CASH_APP';
  return null;
}

const money = (s: string) => Number(s.replace(/[,\s]/g, ''));
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function dateFrom(text: string): Date | null {
  // "Date 10/04/2026", "Sent on Oct 4, 2026", "Transfer Date and Amount: Oct 9, 2026".
  const labelled = /(?:date|sent on|received on|deposited on|\bon)\b[^\n\d$]{0,25}?((?:\d{1,2}\/\d{1,2}\/\d{2,4})|(?:[A-Za-z]{3,9}\.? \d{1,2},? \d{4}))/i.exec(text);
  const raw = labelled?.[1];
  if (!raw) return null;
  let y: number, m: number, d: number;
  const num = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw);
  if (num) { m = +num[1] - 1; d = +num[2]; y = +num[3] < 100 ? 2000 + +num[3] : +num[3]; }
  else {
    const w = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(raw);
    if (!w) return null;
    m = MONTHS.indexOf(w[1].slice(0, 3).toLowerCase()); d = +w[2]; y = +w[3];
    if (m < 0) return null;
  }
  if (m < 0 || m > 11 || d < 1 || d > 31 || y < 2000) return null;
  return new Date(Date.UTC(y, m, d));
}

function cleanName(raw: string): string | null {
  const words = raw.replace(/[^A-Za-z0-9.'&\- ]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length && NOT_NAME.has(words[0].toLowerCase())) words.shift();
  while (words.length && NOT_NAME.has(words[words.length - 1].toLowerCase())) words.pop();
  const name = words.join(' ').trim();
  return name.length >= 2 && /[A-Za-z]{2}/.test(name) ? name : null;
}

function payerFrom(subject: string, body: string): string | null {
  // "JACOB ADAMS sent you $4,452.00", "Jacob Adams paid you $50.00": up to five
  // capitalised words right before the verb. Subject first: it is the cleanest.
  // Same line only: "Wells Fargo\nJACOB ADAMS sent you" is not from "Wells Fargo JACOB ADAMS".
  // Digits count: "100 MAIN ST LLC sent you $314.00", "200-210 OAK ST LLC".
  // A comma inside a business name counts too: "SAMPLE GROUP, LLC sent you" was read as "LLC".
  const before = /((?:[A-Z0-9][A-Za-z0-9.'&-]*,?[ \t]+){0,5}[A-Z][A-Za-z0-9.'&-]*)[ \t]+(?:has[ \t]+|just[ \t]+)?(?:sent|paid)[ \t]+you\b/;
  for (const t of [subject, body]) {
    const m = before.exec(t);
    const n = m && cleanName(m[1]);
    if (n) return n;
  }
  // "Sender: JACOB ADAMS", "From JACOB ADAMS" on a line of its own.
  const labelled = /(?:^|\n)\s*(?:sender|sent by|from|payer)\s*:?\s+([A-Za-z][A-Za-z.'& -]{1,60})\s*(?:\n|$)/i.exec(body);
  const n = labelled && cleanName(labelled[1]);
  if (n && !/@/.test(labelled![1])) return n;
  // "You received $50.00 from Jacob Adams"
  const after = /received\s+\$\s?[\d,]+(?:\.\d{2})?\s+from\s+((?:[A-Z][A-Za-z.'&-]*\s?){1,5})/.exec(`${subject}\n${body}`);
  return after ? cleanName(after[1]) : null;
}

function amountFrom(subject: string, body: string): number | null {
  const tries = [
    /(?:sent|paid)\s+you\s+\$\s?([\d,]+(?:\.\d{2})?)/i,
    /received\s+\$\s?([\d,]+(?:\.\d{2})?)/i,
    /amount\s*(?:received|sent)?\s*:?\s*\$\s?([\d,]+(?:\.\d{2})?)/i,
  ];
  for (const t of [subject, body]) for (const re of tries) {
    const m = re.exec(t);
    if (m) { const n = money(m[1]); if (n > 0) return n; }
  }
  const any = /\$\s?([\d,]+\.\d{2})/.exec(subject) ?? /\$\s?([\d,]+\.\d{2})/.exec(body);
  return any ? money(any[1]) || null : null;
}

/**
 * The payment in a "you received money" email, or null when the email is not
 * one (a payment the owner sent, a request, a promotion, a statement).
 */
export function parseP2PEmail(from: string, subject: string, body: string, receivedAt: Date | null): P2PPayment | null {
  const channel = channelOf(from, subject, body);
  if (!channel) return null;
  const head = `${subject}\n${body.slice(0, 1500)}`;
  if (!INCOMING.test(head)) return null;
  if (OUTGOING.test(subject)) return null;
  const payer = payerFrom(subject, body);
  const amount = amountFrom(subject, body);
  if (!payer || !amount) return null;

  const confirmation = /(?:confirmation|transaction|reference|transfer|payment)\s*(?:number|no\.?|#|id|code)?\s*:?\s*#?\s*([A-Za-z0-9-]{6,40})/gi;
  let conf: string | null = null;
  for (let m; (m = confirmation.exec(body)); ) if (/\d/.test(m[1])) { conf = m[1]; break; }

  const last4 = /(?:ending in|ending|ends in|account\s*(?:no\.?|number|#)?\s*(?:\.{2,}|x+|\*+|#))\s*:?\s*[x*.]*(\d{4})\b/i.exec(body)
    ?? /deposit[^\n]{0,60}?(?:\.{2,}|…|x{2,}|\*{2,})\s*(\d{4})\b/i.exec(body);
  const memoM = /(?:^|\n)\s*(?:memo|note|message|for)\s*:?\s+["“]?([^\n"”]{1,80})/i.exec(body);
  const forM = /(?:sent|paid) you \$[\d,]+(?:\.\d{2})? for ([^\n.]{1,80})/i.exec(`${subject}\n${body}`);
  // Venmo puts the note right after the amount: "paid you $ 200. 00 2nd August Rent Payment See transaction".
  const venmoM = /(?:paid|sent) you \$\s?[\d,]+\s?\.\s?\d{2}[ \t]+([^\n]{1,80}?)[ \t]+See transaction/i.exec(body);
  // Chase on one line: "... Transaction number 31000000001 Memo Rent Oct".
  const inlineM = /\bMemo:?\s+(?!\$)([^\n]{1,80})/.exec(body);
  const memoRaw = memoM?.[1] ?? forM?.[1] ?? venmoM?.[1] ?? inlineM?.[1] ?? null;
  // On one line, the memo runs into the next sentence ("Memo: CC We deposited the money ...").
  const memo = memoRaw ? memoRaw.replace(/\s+(we deposited|the money|go to|have any|see transaction)\b.*$/i, '').trim() || null : null;

  const local = receivedAt ? receivedAt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) : null;
  const date = dateFrom(body) ?? (local ? new Date(`${local}T00:00:00Z`) : null);
  if (!date) return null;
  return { channel, payer, amount, date, confirmation: conf, depositLast4: last4?.[1] ?? null, memo };
}

/**
 * The rent month a payment is for. The memo wins when it names a month
 * ("2nd August Rent Payment" sent Oct 3 is for August); otherwise the month
 * it was sent in.
 */
/** The memo in a bank descriptor: what follows "REF # <id>" ("ZELLE FROM JANE SAMPLE ON 09/30 REF # ABC123 OCTOBER RENT"). */
export function descriptorMemo(name: string | null | undefined): string | null {
  const m = /\bREF\s*#?\s*\S+\s+(.+)$/i.exec(name ?? '');
  return m ? m[1].trim() || null : null;
}

export function periodFor(date: Date, memo: string | null | undefined): Date {
  // Whole month names or their short forms only: "JANE" is not January, nor "MARCUS" March.
  const m = memo && /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)s?\b/i.exec(memo);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    // The latest such month no more than a month after the payment.
    let y = date.getUTCFullYear();
    const diff = month - date.getUTCMonth();
    if (diff > 1) y -= 1; // August's rent paid in October
    else if (diff < -10) y += 1; // January's rent paid in December
    return new Date(Date.UTC(y, month, 1));
  }
  return periodStartOf(date);
}

/**
 * The rent payment this transfer already is: logged by hand on this lease for
 * this amount around this date, or logged from the other source's copy of the
 * same transfer (the email when this is the bank row, or the other way round,
 * when the two were not paired). A payment already accounted for by another
 * transfer from the same source, or by one with a different reference, is a
 * different payment: two real $1,000 Zelles on one day each get their own.
 */
export async function findLoggedPayment(leaseId: string, amount: number, date: Date, from?: { source: 'bank' | 'email'; reference?: string | null }) {
  const candidates = await db.rentPayment.findMany({
    where: { leaseId, amount, paidDate: { gte: new Date(date.getTime() - 5 * DAY), lte: new Date(date.getTime() + 5 * DAY) } },
    select: { id: true, paidDate: true },
  });
  // Nearest in date first.
  candidates.sort((a, b) => Math.abs(a.paidDate.getTime() - date.getTime()) - Math.abs(b.paidDate.getTime() - date.getTime()));
  const ref = from?.reference?.trim().toLowerCase();
  for (const p of candidates) {
    const users = await db.incomingTransaction.findMany({ where: { rentPaymentId: p.id }, select: { source: true, confirmation: true, name: true } });
    if (!users.length) return { id: p.id };
    if (!from) continue;
    const sameTransfer = users.every(u => {
      if ((u.source ?? 'bank') === from.source) return false;
      const theirs = [u.confirmation, /\bREF\s*#?\s*(\S+)/i.exec(u.name ?? '')?.[1]].filter(Boolean).map(x => x!.toLowerCase());
      return !ref || !theirs.length || theirs.includes(ref);
    });
    if (sameTransfer) return { id: p.id };
  }
  return null;
}

/**
 * The same transfer already in the queue from the other source (bank feed vs.
 * email). Two same-amount transfers on one day are two payments, so each pairs
 * with its own: the Zelle reference first (the bank descriptor carries it,
 * "REF # JPM99ABC123", and so does the email), and never a row already paired
 * with a different reference.
 */
export async function findTwin(userId: string, amount: number, date: Date, otherSource: 'bank' | 'email', bankAccountId?: string | null, reference?: string | null) {
  const rows = await db.incomingTransaction.findMany({
    where: {
      userId, amount, source: otherSource,
      date: { gte: new Date(date.getTime() - 4 * DAY), lte: new Date(date.getTime() + 4 * DAY) },
      ...(bankAccountId ? { OR: [{ bankAccountId }, { bankAccountId: null }] } : {}),
    },
    orderBy: { date: 'asc' },
  });
  const ref = reference?.trim().toLowerCase();
  const refsOf = (r: typeof rows[number]) => [r.confirmation, /\bREF\s*#?\s*(\S+)/i.exec(r.name ?? '')?.[1]].filter(Boolean).map(x => x!.toLowerCase());
  if (ref) {
    const same = rows.find(r => refsOf(r).includes(ref));
    if (same) return same;
    // A row carrying another reference is another transfer.
    return rows.find(r => refsOf(r).length === 0) ?? null;
  }
  return rows[0] ?? null;
}

export type P2PResult = { outcome: 'payment'; detail: string };

/**
 * Put a payment read from an email in the Incoming Payments queue, logging it
 * when the tenant is certain. `key` identifies the email, so a second read of
 * it (or of the same email in another mailbox) adds nothing.
 */
export async function recordP2PEmail(userId: string, p: P2PPayment, key: string): Promise<P2PResult> {
  const id = `email:${key}`.slice(0, 300);
  const fmt = `$${p.amount.toFixed(2)} from ${p.payer}`;
  if (await db.incomingTransaction.findUnique({ where: { plaidTransactionId: id }, select: { id: true } })) {
    return { outcome: 'payment', detail: `${fmt}: already in Incoming Payments` };
  }

  // The same transfer told twice, by Zelle and by the bank, or a second copy of the email.
  const sameFromEmail = await db.incomingTransaction.findFirst({
    where: {
      userId, amount: p.amount, source: 'email',
      date: { gte: new Date(p.date.getTime() - 2 * DAY), lte: new Date(p.date.getTime() + 2 * DAY) },
      OR: [{ name: { equals: p.payer, mode: 'insensitive' } }, ...(p.confirmation ? [{ confirmation: p.confirmation }] : [])],
    },
    select: { id: true },
  });
  if (sameFromEmail) return { outcome: 'payment', detail: `${fmt}: already in Incoming Payments from another email` };

  // Which of the owner's accounts it went into, when the email says and only one fits.
  let bankAccountId: string | null = null;
  if (p.depositLast4) {
    const accts = await db.bankAccount.findMany({
      where: { userId, last4: p.depositLast4, accountType: { notIn: ['CREDIT_CARD'] } }, select: { id: true },
    });
    if (accts.length === 1) bankAccountId = accts[0].id;
  }

  const nameMatch = await matchLease(p.payer, userId);
  const matchedLeaseId = nameMatch?.leaseId ?? await matchLeaseByAmount(p.amount, userId);
  // Someone the owner already said is not a tenant (family, their own LLCs):
  // kept for the record, not put in front of them again.
  const ignoredBefore = !nameMatch && await db.incomingTransaction.findFirst({
    where: { userId, source: 'email', status: 'IGNORED', name: { equals: p.payer, mode: 'insensitive' } }, select: { id: true },
  });
  const extra = { source: 'email', confirmation: p.confirmation, memo: p.memo, depositLast4: p.depositLast4 };

  // The bank feed may already have this transfer: add what the email knows
  // (who sent it) to that row instead of adding a second one.
  const twin = await findTwin(userId, p.amount, p.date, 'bank', bankAccountId, p.confirmation);
  if (twin) {
    await db.incomingTransaction.update({
      where: { id: twin.id },
      data: {
        confirmation: twin.confirmation ?? p.confirmation, memo: twin.memo ?? p.memo, depositLast4: twin.depositLast4 ?? p.depositLast4,
        ...(twin.status === 'UNMATCHED' && matchedLeaseId ? { matchedLeaseId, status: 'SUGGESTED' } : {}),
      },
    });
    return { outcome: 'payment', detail: `${fmt}: already in Incoming Payments from the bank feed` };
  }

  const created = await db.incomingTransaction.create({
    data: {
      userId, bankAccountId, plaidTransactionId: id, amount: p.amount, date: p.date,
      name: p.payer, channel: p.channel, matchedLeaseId: ignoredBefore ? null : matchedLeaseId,
      status: ignoredBefore ? 'IGNORED' : matchedLeaseId ? 'SUGGESTED' : 'UNMATCHED', ...extra,
    },
  });
  if (ignoredBefore) return { outcome: 'payment', detail: `${fmt}: ignored, like earlier payments from ${p.payer}` };
  if (!matchedLeaseId) return { outcome: 'payment', detail: `${fmt}: no tenant matched, waiting in Finances → Incoming` };

  // Logged already by hand: link to it rather than log it twice.
  const logged = await findLoggedPayment(matchedLeaseId, p.amount, p.date, { source: 'email', reference: p.confirmation });
  if (logged) {
    await db.incomingTransaction.update({ where: { id: created.id }, data: { status: 'APPLIED', rentPaymentId: logged.id } });
    return { outcome: 'payment', detail: `${fmt}: matches a payment already logged` };
  }

  const lease = await db.lease.findUnique({ where: { id: matchedLeaseId }, select: { rentAmount: true, arrearsBalance: true } });
  const sure = sureOfTenant(nameMatch, lease, p.amount, p.memo);
  if (!sure) return { outcome: 'payment', detail: `${fmt}: tenant suggested, waiting in Finances → Incoming` };

  const payment = await recordRentPayment({
    leaseId: matchedLeaseId,
    periodDate: periodFor(p.date, p.memo),
    amount: p.amount,
    paidDate: p.date,
    method: (CHANNEL_TO_METHOD[p.channel] ?? 'OTHER') as any,
    bankAccountId: bankAccountId ?? undefined,
    notes: [`Logged from ${p.channel === 'CASH_APP' ? 'Cash App' : p.channel === 'APPLE_CASH' ? 'Apple Cash' : p.channel[0] + p.channel.slice(1).toLowerCase()} email`, p.confirmation && `confirmation ${p.confirmation}`, p.memo && `memo "${p.memo}"`].filter(Boolean).join(' · '),
  });
  await db.incomingTransaction.update({ where: { id: created.id }, data: { status: 'APPLIED', rentPaymentId: payment.id } });
  return { outcome: 'payment', detail: `${fmt}: logged as rent` };
}
