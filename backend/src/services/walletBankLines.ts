/**
 * Bank lines that move money in or out of a wallet (lib/walletLines.ts), recorded on Cash, checks &
 * apps as the bank sync sees them: a Venmo cash-out arriving, money added to Cash App, an ATM
 * withdrawal (into Cash), a cash deposit (out of Cash).
 *
 * The same move is often recorded already — read from the app's email (walletEmails), or typed in
 * by hand. That entry is then marked as seen by the bank too (`source` gains "+bank", and the bank
 * account it went through is filled in) instead of a second one being added; and an email read
 * after the bank line finds it the same way. Lines dated before a wallet's start are left alone: its
 * opening balance already has them.
 */
import { db } from '../config/db';
import { ensureWallets, WALLET_LABEL, type WalletKind } from './wallets';
import type { WalletLine } from '../lib/walletLines';

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A move already on a wallet: the same kind (to a bank, or from one) and amount within a few days,
 * not yet seen from `notFrom` (the bank feed, or the app's email), through the same bank account if it names one.
 */
export async function walletTwin(walletId: string, type: 'TO_BANK' | 'FROM_BANK', signedAmount: number, date: Date, notFrom: 'bank' | 'email', bankAccountId: string | null) {
  const rows = await db.walletMovement.findMany({
    where: { walletId, type, amount: signedAmount, date: { gte: new Date(date.getTime() - 6 * DAY), lte: new Date(date.getTime() + 6 * DAY) } },
    orderBy: { date: 'asc' },
  });
  return rows.find(m => !(m.source ?? '').includes(notFrom) && (!m.bankAccountId || !bankAccountId || m.bankAccountId === bankAccountId)) ?? null;
}

/** A move this reference (an email's Message-ID, a bank line's plaid:<id>) already recorded or matched. */
export async function seenBefore(userId: string, ref: string): Promise<boolean> {
  return !!(await db.walletMovement.findFirst({ where: { wallet: { userId }, OR: [{ sourceRef: ref }, { seenRefs: { has: ref } }] }, select: { id: true } }));
}

export async function recordWalletLine(
  userId: string,
  account: { id: string; name: string; last4: string | null },
  tx: { id: string; amount: number; date: Date; name: string },
  line: WalletLine,
): Promise<{ recorded: 'new' | 'matched' | 'seen' | 'before-start'; detail: string }> {
  const ref = `plaid:${tx.id}`;
  if (await seenBefore(userId, ref)) return { recorded: 'seen', detail: 'already recorded' };
  const wallets = await ensureWallets(userId);
  const wallet = wallets.find(w => w.kind === line.wallet)!;
  if (tx.date < wallet.startedAt) return { recorded: 'before-start', detail: `before ${WALLET_LABEL[line.wallet as WalletKind]} started counting` };

  const into = line.kind === 'BANK_TO_APP' || line.kind === 'CASH_WITHDRAWAL';   // money into the wallet
  const amount = r2(Math.abs(tx.amount));
  const signed = into ? amount : -amount;
  const type = into ? 'FROM_BANK' : 'TO_BANK';
  const acct = `${account.name}${account.last4 && !account.name.includes(account.last4) ? ` ··${account.last4}` : ''}`;

  const twin = await walletTwin(wallet.id, type, signed, tx.date, 'bank', account.id);
  if (twin) {
    await db.walletMovement.update({ where: { id: twin.id }, data: { source: `${twin.source ?? 'manual'}+bank`, seenRefs: { push: ref }, ...(twin.bankAccountId ? {} : { bankAccountId: account.id }) } });
    return { recorded: 'matched', detail: `${WALLET_LABEL[line.wallet as WalletKind]} entry of $${amount.toFixed(2)} matched to ${acct}` };
  }
  const label = WALLET_LABEL[line.wallet as WalletKind];
  const description = line.kind === 'APP_TO_BANK' ? `Transfer to ${acct}`
    : line.kind === 'BANK_TO_APP' ? `Added from ${acct}`
    : line.kind === 'CASH_WITHDRAWAL' ? `Withdrawn from ${acct}`
    : `Deposited into ${acct}`;
  await db.walletMovement.create({
    data: { walletId: wallet.id, date: tx.date, amount: signed, type, bankAccountId: account.id, description: `${description} · ${tx.name.slice(0, 80)}`, source: 'bank', sourceRef: ref },
  });
  return { recorded: 'new', detail: `${label}: ${description.toLowerCase()} $${amount.toFixed(2)}` };
}
