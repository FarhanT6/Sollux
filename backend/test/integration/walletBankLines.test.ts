/**
 * Money moving to and from the wallets on Cash, checks & apps, from the bank feed and the apps'
 * emails: each move recorded once whichever arrives first, re-reads change nothing, cash
 * withdrawals and deposits move the Cash wallet, and lines from before a wallet started are left
 * to its opening balance. Made-up accounts and amounts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const DAY = 86_400_000;
const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const daysAgo = (n: number) => new Date(today.getTime() - n * DAY);

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const me = await api.db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * DAY) } as any });
  ids.user = me.id;
  ids.a = (await api.db.bankAccount.create({ data: { userId: me.id, name: 'Business Checking', bank: 'Example Bank', last4: '2222', accountType: 'CHECKING' } as any })).id;
  const { ensureWallets } = await import('../../src/services/wallets');
  // Wallets counting from 20 days ago.
  for (const w of await ensureWallets(me.id)) await api.db.wallet.update({ where: { id: w.id }, data: { startedAt: daysAgo(20) } });
});
after(async () => { if (!skip) await api.stop(); });

const acct = () => ({ id: ids.a, name: 'Business Checking', last4: '2222' });
const moves = async (kind: string) => api.db.walletMovement.findMany({ where: { wallet: { userId: ids.user, kind } }, orderBy: { createdAt: 'asc' } });

test('a Venmo cash-out from the bank feed, then its email: one transfer, seen by both', { skip }, async () => {
  const { recordWalletLine } = await import('../../src/services/walletBankLines');
  const { recordWithdrawal } = await import('../../src/services/walletEmails');
  const r1 = await recordWalletLine(ids.user, acct(), { id: 'tx-venmo-1', amount: -700, date: daysAgo(1), name: 'VENMO CASHOUT' }, { kind: 'APP_TO_BANK', wallet: 'VENMO' });
  assert.equal(r1.recorded, 'new');
  assert.equal((await recordWalletLine(ids.user, acct(), { id: 'tx-venmo-1', amount: -700, date: daysAgo(1), name: 'VENMO CASHOUT' }, { kind: 'APP_TO_BANK', wallet: 'VENMO' })).recorded, 'seen');
  await recordWithdrawal(ids.user, { wallet: 'VENMO', amount: 700, date: daysAgo(2), last4: '2222', bank: null, instant: false }, '<venmo-email-1@example.com>');
  await recordWithdrawal(ids.user, { wallet: 'VENMO', amount: 700, date: daysAgo(2), last4: '2222', bank: null, instant: false }, '<venmo-email-1@example.com>');
  const m = await moves('VENMO');
  assert.equal(m.length, 1);
  assert.deepEqual([Number(m[0].amount), m[0].type, m[0].source, m[0].bankAccountId], [-700, 'TO_BANK', 'bank+email', ids.a]);
  assert.deepEqual(m[0].seenRefs, ['<venmo-email-1@example.com>']);
});

test('money added to Cash App: the email first, then the bank line — one entry', { skip }, async () => {
  const { recordWalletLine } = await import('../../src/services/walletBankLines');
  const { recordTopUp } = await import('../../src/services/walletEmails');
  await recordTopUp(ids.user, { wallet: 'CASH_APP', amount: 50, date: daysAgo(3), last4: null, bank: null }, '<cashapp-add-1@example.com>');
  const r = await recordWalletLine(ids.user, acct(), { id: 'tx-cashapp-1', amount: 50, date: daysAgo(2), name: 'Cash App*Add Cash' }, { kind: 'BANK_TO_APP', wallet: 'CASH_APP' });
  assert.equal(r.recorded, 'matched');
  const m = await moves('CASH_APP');
  assert.equal(m.length, 1);
  assert.deepEqual([Number(m[0].amount), m[0].type, m[0].source, m[0].bankAccountId], [50, 'FROM_BANK', 'email+bank', ids.a]);
  // The bank line read again (a re-sync) changes nothing.
  assert.equal((await recordWalletLine(ids.user, acct(), { id: 'tx-cashapp-1', amount: 50, date: daysAgo(2), name: 'Cash App*Add Cash' }, { kind: 'BANK_TO_APP', wallet: 'CASH_APP' })).recorded, 'seen');
});

test('cash: an ATM withdrawal adds to Cash, a deposit typed in by hand is matched, not doubled', { skip }, async () => {
  const { recordWalletLine } = await import('../../src/services/walletBankLines');
  const { addMovement } = await import('../../src/services/wallets');
  const cashWallet = (await api.db.wallet.findFirst({ where: { userId: ids.user, kind: 'CASH' } }))!;
  await addMovement(ids.user, cashWallet.id, { date: daysAgo(4), amount: 300, type: 'TO_BANK', bankAccountId: null, description: 'Deposited at the branch' });
  assert.equal((await recordWalletLine(ids.user, acct(), { id: 'tx-dep-1', amount: -300, date: daysAgo(3), name: 'CASH DEPOSIT' }, { kind: 'CASH_DEPOSIT', wallet: 'CASH' })).recorded, 'matched');
  assert.equal((await recordWalletLine(ids.user, acct(), { id: 'tx-atm-1', amount: 200, date: daysAgo(1), name: 'ATM WITHDRAWAL' }, { kind: 'CASH_WITHDRAWAL', wallet: 'CASH' })).recorded, 'new');
  const m = await moves('CASH');
  assert.deepEqual(m.map(x => [Number(x.amount), x.type, x.source]), [[-300, 'TO_BANK', 'manual+bank'], [200, 'FROM_BANK', 'bank']]);
  const { walletReport } = await import('../../src/services/wallets');
  const cash = (await walletReport(ids.user)).wallets.find((w: any) => w.kind === 'CASH')!;
  assert.equal(cash.balance, -100);
});

test('a line from before the wallet started counting is left to its opening balance', { skip }, async () => {
  const { recordWalletLine } = await import('../../src/services/walletBankLines');
  const r = await recordWalletLine(ids.user, acct(), { id: 'tx-old-1', amount: -400, date: daysAgo(60), name: 'VENMO CASHOUT' }, { kind: 'APP_TO_BANK', wallet: 'VENMO' });
  assert.equal(r.recorded, 'before-start');
  assert.equal((await moves('VENMO')).length, 1);
});

test("Plaid's new-transactions webhook is answered, for a bank on file or not", { skip }, async () => {
  const r = await fetch(`${api.url}/api/plaid/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-not-on-file' }) });
  assert.equal(r.status, 200);
});
