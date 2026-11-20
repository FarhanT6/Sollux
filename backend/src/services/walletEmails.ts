/**
 * A payment app's "transferred to your bank" email: money leaving Venmo, Cash
 * App, PayPal or Apple Cash for a bank account. Read with patterns, like the
 * money-received emails (p2pPaymentEmails), and recorded as a transfer out of
 * that wallet, to the bank account the email names when one of the owner's
 * matches (its last four, else its bank's name).
 */
import { db } from '../config/db';
import { ensureWallets, addMovement, WALLET_LABEL, type WalletKind } from './wallets';
import { seenBefore, walletTwin } from './walletBankLines';

export interface Withdrawal { wallet: Exclude<WalletKind, 'CASH'>; amount: number; date: Date; last4: string | null; bank: string | null; instant: boolean }

const BANKS = ['Chase', 'Wells Fargo', 'Bank of America', 'Citi', 'Citibank', 'Capital One', 'U.S. Bank', 'US Bank', 'Navy Federal', 'USAA', 'PNC', 'TD Bank', 'Truist', 'Ally', 'Discover', 'American Express', 'SoFi', 'Chime', 'Varo', 'Schwab', 'Fidelity', 'Golden 1', 'Union Bank', 'BMO', 'Huntington', 'Regions', 'KeyBank', 'Citizens', 'Santander', 'Mission Fed', 'San Diego County Credit Union', 'SDCCU', 'Frost'];
// Money leaving the app for a bank or a debit card.
const WITHDRAW = /\b(?:you(?:'ve| have)? (?:transferred|withdrawn|withdrew|cashed out)|(?:your )?(?:instant |standard )?transfer (?:to (?:your |the )?bank|has been initiated|is on (?:its|the) way|request)|transfer(?:red)?\b(?:[^.]|\.\d){0,60}?\bto (?:your |the )?(?:bank|debit card)|cash(?:ed)? out|withdrawal (?:to|request|of)|withdr[ae]wn? (?:to|from))/i;
// Not a withdrawal: money in, a purchase, a failed or cancelled transfer.
const NOT = /\b(?:sent you|paid you|you(?:'ve| have)? received|money request|request(?:ed)? from|failed|declined|cancel(?:l)?ed|reversed|returned|could ?n[o']t|unable to)\b/i;

function walletOf(from: string, subject: string, body: string): Withdrawal['wallet'] | null {
  const f = from.toLowerCase();
  if (/venmo\.com/.test(f)) return 'VENMO';
  if (/cash\.app|square(?:up)?\.com/.test(f)) return 'CASH_APP';
  if (/paypal\.com/.test(f)) return 'PAYPAL';
  if (/apple\.com/.test(f) && /apple cash/i.test(`${subject} ${body.slice(0, 3000)}`)) return 'APPLE_CASH';
  return null;
}

export function parseWithdrawalEmail(from: string, subject: string, body: string, receivedAt: Date | null): Withdrawal | null {
  const wallet = walletOf(from, subject, body);
  if (!wallet) return null;
  const text = `${subject}\n${body}`.replace(/\s+/g, ' ');
  const at = text.search(WITHDRAW);
  if (at < 0 || NOT.test(subject)) return null;
  // The amount nearest the withdrawal wording.
  const near = text.slice(Math.max(0, at - 200), at + 400);
  const amt = near.match(/\$\s?([\d,]+\.\d{2})/) ?? text.match(/\$\s?([\d,]+\.\d{2})/);
  if (!amt) return null;
  const amount = Number(amt[1].replace(/,/g, ''));
  if (!(amount > 0)) return null;
  const last4 = text.match(/(?:ending (?:in )?|account (?:number )?|x{2,}|\bx-|[•*·]{1,4}\s?|\.\.\.)(\d{4})\b/i)?.[1] ?? null;
  const bank = BANKS.find(b => new RegExp(`\\b${b.replace(/[.]/g, '\\.').replace(/ /g, '\\s+')}\\b`, 'i').test(text)) ?? null;
  const d = receivedAt ?? new Date();
  return { wallet, amount, date: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), last4, bank, instant: /\binstant\b/i.test(text) };
}

/** The owner's bank account an email names: by its last four, else its bank's name (one match only). */
async function namedAccount(userId: string, last4: string | null, bank: string | null) {
  const banks = await db.bankAccount.findMany({ where: { userId, isActive: true, accountType: { not: 'CREDIT_CARD' } }, select: { id: true, name: true, bank: true, last4: true } });
  const byLast4 = last4 ? banks.filter(b => b.last4 === last4) : [];
  const byBank = bank ? banks.filter(b => `${b.bank ?? ''} ${b.name}`.toLowerCase().includes(bank.toLowerCase())) : [];
  const account = byLast4.length === 1 ? byLast4[0] : byBank.length === 1 ? byBank[0] : null;
  const where = account ? `${account.name}${account.last4 ? ` ••${account.last4}` : ''}` : [bank, last4 && `ending ${last4}`].filter(Boolean).join(' ') || 'your bank';
  return { account, where };
}

/**
 * Record a move between an app and a bank read from the app's email, once per email. The same move
 * already on the wallet — from the bank feed, or typed in — is marked as seen in the email too
 * (and given the bank account the email names) instead of being recorded twice.
 */
async function recordAppMove(userId: string, wallet: Withdrawal['wallet'], type: 'TO_BANK' | 'FROM_BANK', w: { amount: number; date: Date; last4: string | null; bank: string | null }, ref: string, describe: (where: string) => string) {
  const label = WALLET_LABEL[wallet];
  if (await seenBefore(userId, ref)) return { outcome: 'wallet' as const, detail: 'already recorded' };
  const wallets = await ensureWallets(userId);
  const target = wallets.find(x => x.kind === wallet)!;
  const { account, where } = await namedAccount(userId, w.last4, w.bank);
  const twin = await walletTwin(target.id, type, type === 'TO_BANK' ? -w.amount : w.amount, w.date, 'email', account?.id ?? null);
  if (twin) {
    await db.walletMovement.update({ where: { id: twin.id }, data: { source: `${twin.source ?? 'manual'}+email`, seenRefs: { push: ref }, ...(twin.bankAccountId || !account ? {} : { bankAccountId: account.id }) } });
    return { outcome: 'wallet' as const, detail: `${label} $${w.amount.toFixed(2)} already recorded — matched to its email` };
  }
  await addMovement(userId, target.id, { date: w.date, amount: w.amount, type, bankAccountId: account?.id ?? null, source: 'email', sourceRef: ref, description: describe(where) + (account ? '' : ' (not matched to a bank account in Sollux)') });
  return { outcome: 'wallet' as const, detail: `${label} ${type === 'TO_BANK' ? 'transfer' : 'money added'} of $${w.amount.toFixed(2)} ${type === 'TO_BANK' ? 'to' : 'from'} ${where}` };
}

/** Record it as money out of the wallet, to the matching bank account. Once per email. */
export async function recordWithdrawal(userId: string, w: Withdrawal, ref: string): Promise<{ outcome: 'wallet'; detail: string }> {
  return recordAppMove(userId, w.wallet, 'TO_BANK', w, ref, where => `${w.instant ? 'Instant transfer' : 'Transfer'} to ${where}`);
}

/** Money added to an app's balance from a bank ("You added $50.00 to your Cash balance"). */
export interface TopUp { wallet: Withdrawal['wallet']; amount: number; date: Date; last4: string | null; bank: string | null }
const TOP_UP = /\byou(?:'ve| have)? added\s+(?:money|funds|cash|\$)|\badded\s+\$?[\d,]*\.?\d*\s*(?:to|into) (?:your )?(?:venmo|cash|paypal|apple cash)\b|\bmoney (?:was )?added to (?:your )?(?:venmo|paypal|apple cash|cash)\b|\btransfer(?:red)? (?:\$[\d,.]+ )?from (?:your )?bank(?: account)? to (?:your )?(?:venmo|paypal|cash app|apple cash)\b/i;
const TOP_UP_NOT = /\b(?:failed|declined|cancel(?:l)?ed|reversed|returned|could ?n[o']t|unable to|pending review|new (?:bank|card|debit card)|linked)\b/i;
export function parseTopUpEmail(from: string, subject: string, body: string, receivedAt: Date | null): TopUp | null {
  const wallet = walletOf(from, subject, body);
  if (!wallet) return null;
  const text = `${subject}\n${body}`.replace(/\s+/g, ' ');
  const at = text.search(TOP_UP);
  if (at < 0 || TOP_UP_NOT.test(subject)) return null;
  const near = text.slice(Math.max(0, at - 200), at + 400);
  const amt = near.match(/\$\s?([\d,]+\.\d{2})/);
  if (!amt) return null;
  const amount = Number(amt[1].replace(/,/g, ''));
  if (!(amount > 0)) return null;
  const last4 = text.match(/(?:ending (?:in )?|account (?:number )?|x{2,}|\bx-|[•*·]{1,4}\s?|\.\.\.)(\d{4})\b/i)?.[1] ?? null;
  const bank = BANKS.find(b => new RegExp(`\\b${b.replace(/[.]/g, '\\.').replace(/ /g, '\\s+')}\\b`, 'i').test(text)) ?? null;
  const d = receivedAt ?? new Date();
  return { wallet, amount, date: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), last4, bank };
}
export async function recordTopUp(userId: string, t: TopUp, ref: string): Promise<{ outcome: 'wallet'; detail: string }> {
  return recordAppMove(userId, t.wallet, 'FROM_BANK', t, ref, where => `Added from ${where}`);
}
