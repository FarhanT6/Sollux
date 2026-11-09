/** Cash and app balances: this month's rent by that method counts in; a transfer email takes money out to the matching bank. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  ids.user = me.id;
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const u = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'A' } });
  const lease = await db.lease.create({ data: { unitId: u.id, rentAmount: 1000, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2026-01-01') } as any });
  const thisMonth = monthStart();
  // Venmo rent this month counts; last month's does not (balances start this month).
  await db.rentPayment.create({ data: { leaseId: lease.id, periodDate: thisMonth, amount: 1000, paidDate: new Date(thisMonth.getTime() + 2 * 86_400_000), method: 'VENMO' } });
  await db.rentPayment.create({ data: { leaseId: lease.id, periodDate: new Date(thisMonth.getTime() - 20 * 86_400_000), amount: 900, paidDate: new Date(thisMonth.getTime() - 20 * 86_400_000), method: 'VENMO' } });
  const bank = await db.bankAccount.create({ data: { userId: me.id, name: 'Checking', bank: 'Chase', last4: '1350', accountType: 'CHECKING' } as any });
  ids.bank = bank.id;
  // Two checks and a money order this month: one logged as deposited when it came in, two still on hand.
  const day = (n: number) => new Date(thisMonth.getTime() + n * 86_400_000);
  ids.check1 = (await db.rentPayment.create({ data: { leaseId: lease.id, periodDate: thisMonth, amount: 500, paidDate: day(1), method: 'CHECK', notes: 'Ref 1042' } })).id;
  ids.check2 = (await db.rentPayment.create({ data: { leaseId: lease.id, periodDate: thisMonth, amount: 250, paidDate: day(1), method: 'MONEY_ORDER' } })).id;
  await db.rentPayment.create({ data: { leaseId: lease.id, periodDate: thisMonth, amount: 300, paidDate: day(1), method: 'CHECK', bankAccountId: bank.id } });
});
after(async () => { if (!skip) await api.stop(); });

const send = (method: string, path: string, body?: unknown) => fetch(`${api.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('balances: rent in this month, a Venmo transfer out to the bank by email, cash moved to Venmo', { skip }, async () => {
  let r = await (await send('GET', '/wallets')).json() as any;
  const venmo = () => r.wallets.find((w: any) => w.kind === 'VENMO');
  assert.equal(venmo().balance, 1000);

  const { parseWithdrawalEmail, recordWithdrawal } = await import('../../src/services/walletEmails');
  const w = parseWithdrawalEmail('venmo@venmo.com', 'Your transfer has been initiated', "You've transferred $600.00 to your bank. Chase ••1350.", new Date())!;
  const out = await recordWithdrawal(ids.user, w, 'msg-1');
  assert.match(out.detail, /Checking ••1350/);
  assert.match((await recordWithdrawal(ids.user, w, 'msg-1')).detail, /already recorded/);
  r = await (await send('GET', '/wallets')).json() as any;
  assert.equal(venmo().balance, 400);
  assert.equal(venmo().entries.find((e: any) => e.kind === 'TO_BANK').bankAccountId, ids.bank);

  const cash = r.wallets.find((x: any) => x.kind === 'CASH');
  await send('PATCH', `/wallets/${cash.id}`, { openingBalance: 500 });
  r = await (await send('POST', `/wallets/${cash.id}/movements`, { date: new Date().toISOString().slice(0, 10), amount: 200, type: 'TO_WALLET', toWalletId: venmo().id })).json() as any;
  assert.equal(r.wallets.find((x: any) => x.kind === 'CASH').balance, 300);
  assert.equal(venmo().balance, 600);
  const moved = r.wallets.find((x: any) => x.kind === 'CASH').entries.find((e: any) => e.kind === 'TO_WALLET');
  r = await (await send('DELETE', `/wallets/movements/${moved.movementId}`)).json() as any;
  assert.equal(venmo().balance, 400, 'deleting one side removes both');
});

test('checks: on hand until deposited (one deposit slip for several), and a deposit can be undone', { skip }, async () => {
  const checks = (r: any) => r.wallets.find((w: any) => w.kind === 'CHECK');
  let r = await (await send('GET', '/wallets')).json() as any;
  // The check logged with its bank account is deposited already; the other two are on hand.
  assert.equal(checks(r).balance, 750);
  assert.deepEqual(checks(r).onHand.map((c: any) => [c.amount, c.checkNumber]), [[500, '1042'], [250, null]]);
  r = await (await send('POST', '/wallets/checks/deposit', { rentPaymentIds: [ids.check1, ids.check2], bankAccountId: ids.bank, date: new Date().toISOString().slice(0, 10) })).json();
  assert.equal(checks(r).balance, 0);
  assert.equal(checks(r).onHand.length, 0);
  assert.equal(checks(r).entries.filter((e: any) => e.kind === 'CHECK_DEPOSIT').length, 3);
  const pay = await api.db.rentPayment.findUnique({ where: { id: ids.check1 } });
  assert.equal(pay!.bankAccountId, ids.bank);
  r = await (await send('POST', `/wallets/checks/${ids.check2}/undeposit`)).json();
  assert.equal(checks(r).balance, 250);
  // Not a check: refused.
  const venmoRent = await api.db.rentPayment.findFirst({ where: { method: 'VENMO' } });
  assert.equal((await send('POST', `/wallets/checks/${venmoRent!.id}/undeposit`)).status, 404);
});
