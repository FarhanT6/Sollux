/**
 * Pending money the bank has surely taken clears itself: a payment (not a check)
 * a few days after its date or once its loan payment is on record, a deposit
 * after ten days; a check waits; one the owner puts back as still pending stays.
 * The pay planner counts what was sent toward a loan only for the month it pays.
 * Made-up lender, amounts and dates.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const DAY = 86_400_000;
const ago = (n: number) => new Date(Date.now() - n * DAY);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * DAY) } });
  ids.user = me.id;
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  ids.loan = (await db.loan.create({ data: { userId: me.id, propertyId: p.id, lender: 'Example Mortgage Co', loanType: 'MORTGAGE', isActive: true, monthlyPayment: 1500, dueDay: 1 } as any })).id;
  ids.bank = (await db.bankAccount.create({ data: { userId: me.id, name: 'Checking', bank: 'Example Bank', last4: '1234', accountType: 'CHECKING' } as any })).id;
  await db.bankBalance.create({ data: { bankAccountId: ids.bank, balance: 9000, available: 9000, asOfDate: new Date(`${ymd(new Date())}T00:00:00Z`), source: 'plaid' } as any });
  const item = (key: string, data: Record<string, unknown>) => db.pendingOutflow.create({ data: { userId: me.id, bankAccountId: ids.bank, amount: 100, description: key, kind: 'SCHEDULED', direction: 'OUT', ...data } as any }).then(r => { ids[key] = r.id; });
  // Split across accounts by the planner weeks ago: the bank took it as one debit, never matched.
  await item('oldSplit', { amount: 209.35, loanId: ids.loan, expectedDate: ago(41) });
  // Due two days ago, and the loan payment for that month is on record.
  await item('loanPaid', { amount: 1500, loanId: ids.loan, expectedDate: ago(2) });
  await db.loanPayment.create({ data: { loanId: ids.loan, date: ago(2), amount: 1500, status: 'PAID', periodDate: new Date(`${ymd(ago(2)).slice(0, 7)}-01T00:00:00Z`) } as any });
  // Due two days ago, nothing else known: still in flight.
  await item('recent', { amount: 75, expectedDate: ago(2) });
  // A check written two months ago: waits for the bank or the owner.
  await item('oldCheck', { amount: 640, kind: 'CHECK', expectedDate: ago(60) });
  // A deposit fifteen days ago: credited by now.
  await item('oldDeposit', { amount: 300, kind: 'CHECK', direction: 'IN', expectedDate: ago(15) });
  // A payment a month ago the owner will say is still pending.
  await item('kept', { amount: 55, kind: 'TRANSFER', expectedDate: ago(30) });
});
after(async () => { if (!skip) await api.stop(); });

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${api.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('the bank has surely taken it: cleared on its own; a check waits', { skip }, async () => {
  const open = await (await send('GET', '/bank-accounts/pending')).json() as any[];
  assert.deepEqual(open.map(p => p.description).sort(), ['oldCheck', 'recent']);
  const row = async (k: string) => (await api.db.pendingOutflow.findUnique({ where: { id: ids[k] } }))!;
  assert.equal((await row('oldSplit')).clearedBy, 'auto:date');
  assert.equal((await row('loanPaid')).clearedBy, 'auto:loan');
  assert.equal((await row('oldDeposit')).clearedBy, 'auto:date');
  // The balance after pending holds out only what is still in flight.
  const acct = ((await (await send('GET', '/bank-accounts')).json()) as any[]).find(a => a.id === ids.bank);
  assert.equal(acct.pendingOut, 715);
  assert.equal(acct.afterPending, 9000 - 715);
});

test('put back as still pending by the owner: it stays until the bank or the owner clears it', { skip }, async () => {
  assert.equal((await send('PATCH', `/bank-accounts/pending/${ids.kept}`, { cleared: false })).status, 200);
  const open = await (await send('GET', '/bank-accounts/pending')).json() as any[];
  assert.ok(open.some(p => p.id === ids.kept));
  assert.equal((await api.db.pendingOutflow.findUnique({ where: { id: ids.kept } }))!.clearedBy, 'kept');
  // The bank's line still clears it.
  const { clearPendingByTransaction } = await import('../../src/services/pendingMoney');
  assert.equal(await clearPendingByTransaction(ids.bank, { id: 'tx-kept', amount: 55, date: ymd(new Date()), name: 'TRANSFER' }), ids.kept);
});

test('the pay planner: last month\'s payment in flight is not this month\'s', { skip }, async () => {
  const { buildPayPlan } = await import('../../src/lib/payPlan');
  const { db } = api;
  // This month's payment is not on record; a check toward last month's is still in flight.
  await db.loanPayment.deleteMany({ where: { loanId: ids.loan } });
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  await db.pendingOutflow.create({ data: { userId: ids.user, bankAccountId: ids.bank, amount: 1500, description: 'Check to Example Mortgage Co', kind: 'CHECK', direction: 'OUT', loanId: ids.loan, expectedDate: lastMonth } as any });
  let plan = await buildPayPlan(ids.user, { horizonDays: 45 });
  const ob = () => plan.obligations.find(o => o.kind === 'LOAN' && o.id === ids.loan);
  assert.ok(ob(), 'the loan is in the plan');
  assert.equal(ob()!.status, 'DUE');
  // Sent toward the month the plan shows: it is sent.
  await db.pendingOutflow.create({ data: { userId: ids.user, bankAccountId: ids.bank, amount: 1500, description: 'Check to Example Mortgage Co', kind: 'CHECK', direction: 'OUT', loanId: ids.loan, expectedDate: new Date(ob()!.dueDate) } as any });
  plan = await buildPayPlan(ids.user, { horizonDays: 45 });
  assert.equal(ob()!.status, 'SENT');
});

test('checked against the bank\'s own lines: a deposit recorded after the bank had it, posted check by check, clears', { skip }, async () => {
  process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
  const { encrypt } = await import('../../src/crypto/encrypt');
  const { db } = api;
  const item = await db.plaidItem.create({ data: { userId: ids.user, plaidItemId: 'item-test', accessTokenEnc: encrypt('access-test'), institutionId: 'ins_test', institutionName: 'Example Bank' } as any });
  const acct = await db.bankAccount.create({ data: { userId: ids.user, name: 'Business Checking', bank: 'Example Bank', last4: '9173', accountType: 'CHECKING', plaidItemId: item.id, plaidAccountId: 'acct-test' } as any });
  const day = ymd(ago(3));
  const slip = await db.pendingOutflow.create({ data: { userId: ids.user, bankAccountId: acct.id, amount: 4052, description: '4 checks deposited', kind: 'CHECK', direction: 'IN', expectedDate: new Date(`${day}T00:00:00Z`) } as any });
  const check = await db.pendingOutflow.create({ data: { userId: ids.user, bankAccountId: acct.id, amount: 1100, description: 'Check #1205 to Example Trust', kind: 'CHECK', direction: 'OUT', expectedDate: ago(2) } as any });
  // The bank's lines (Plaid: negative is money in): the four checks one by one, and nothing for the check written.
  const { plaidClient } = await import('../../src/config/plaid');
  const lines = [[1200, 'c1'], [1000, 'c2'], [952, 'c3'], [900, 'c4']].map(([a, id]) => ({ transaction_id: id, amount: -(a as number), date: day, account_id: 'acct-test' }));
  (plaidClient as any).transactionsGet = async () => ({ data: { transactions: [...lines, { transaction_id: 'x', amount: 64.12, date: day, account_id: 'acct-test' }] } });
  const { checkPendingWithBank } = await import('../../src/services/pendingMoney');
  assert.equal(await checkPendingWithBank(ids.user), 1);
  const s = await db.pendingOutflow.findUnique({ where: { id: slip.id } });
  assert.equal(s!.cleared, true);
  assert.deepEqual(s!.clearedBy!.slice(6).split('+').sort(), ['c1', 'c2', 'c3', 'c4']);
  assert.equal((await db.pendingOutflow.findUnique({ where: { id: check.id } }))!.cleared, false);
  // A second look does not use the same lines again.
  await db.pendingOutflow.create({ data: { userId: ids.user, bankAccountId: acct.id, amount: 1200, description: 'Check deposited', kind: 'CHECK', direction: 'IN', expectedDate: new Date(`${day}T00:00:00Z`) } as any });
  assert.equal(await checkPendingWithBank(ids.user), 0);
});

test('a loan payment logged before it comes out: pending on its account until the bank shows it, gone with the payment', { skip }, async () => {
  const { db } = api;
  const month = ymd(ago(3)).slice(0, 7);
  const res = await send('POST', `/loans/${ids.loan}/payments`, { date: ymd(ago(3)), amount: 1500, status: 'PAID', method: 'CHECK', confirmationNumber: '1207', periodMonth: month, pendingFrom: ids.bank, allowDuplicate: true });
  assert.equal(res.status, 201);
  const pay = await res.json() as any;
  const item = await db.pendingOutflow.findFirst({ where: { sourceRef: `loanpay:${pay.id}` } });
  assert.ok(item);
  assert.deepEqual([item!.kind, Number(item!.amount), item!.loanId, item!.direction], ['CHECK', 1500, ids.loan, 'OUT']);
  assert.match(item!.description, /Check #1207 to Example Mortgage Co/);
  // The loan shows it paid, and the payment on record does not clear its own pending item.
  const open = await (await send('GET', '/bank-accounts/pending')).json() as any[];
  assert.ok(open.some(p => p.id === item!.id));
  // The bank shows the check cashed: cleared.
  const { clearPendingByTransaction } = await import('../../src/services/pendingMoney');
  assert.equal(await clearPendingByTransaction(ids.bank, { id: 'tx-1207', amount: 1500, date: ymd(new Date()), name: 'CHECK 1207' }), item!.id);
  // Another, by Zelle, deleted before it came out: its pending item goes with it.
  const res2 = await send('POST', `/loans/${ids.loan}/payments`, { date: ymd(new Date()), amount: 333.33, status: 'PAID', method: 'ZELLE', pendingFrom: ids.bank, allowDuplicate: true });
  const pay2 = await res2.json() as any;
  assert.equal((await db.pendingOutflow.findFirst({ where: { sourceRef: `loanpay:${pay2.id}` } }))!.kind, 'SCHEDULED');
  assert.equal((await send('DELETE', `/loans/${ids.loan}/payments/${pay2.id}`)).status, 204);
  assert.equal(await db.pendingOutflow.count({ where: { sourceRef: `loanpay:${pay2.id}` } }), 0);
  // Without "not out yet", nothing is pending.
  const res3 = await send('POST', `/loans/${ids.loan}/payments`, { date: ymd(new Date()), amount: 222.22, status: 'PAID', method: 'ZELLE', allowDuplicate: true });
  assert.equal(await db.pendingOutflow.count({ where: { sourceRef: `loanpay:${(await res3.json() as any).id}` } }), 0);
});

test('a logged loan payment can be changed: its date and amount, and whether it is still pending on the bank', { skip }, async () => {
  const { db } = api;
  const res = await send('POST', `/loans/${ids.loan}/payments`, { date: ymd(ago(1)), amount: 4552.08, status: 'PAID', method: 'CHECK', periodMonth: ymd(ago(1)).slice(0, 7), allowDuplicate: true });
  const pay = await res.json() as any;
  assert.equal(await db.pendingOutflow.count({ where: { sourceRef: `loanpay:${pay.id}` } }), 0);
  // Changed to the day the check was dropped off, and not out of the account yet.
  const patched = await send('PATCH', `/loans/${ids.loan}/payments/${pay.id}`, { date: ymd(ago(3)), method: 'CHECK_DROPPED', confirmationNumber: '1311', pendingFrom: ids.bank });
  assert.equal(patched.status, 200);
  const row = await db.loanPayment.findUnique({ where: { id: pay.id } });
  assert.equal(ymd(row!.date), ymd(ago(3)));
  assert.equal(row!.method, 'CHECK_DROPPED');
  let item = await db.pendingOutflow.findFirst({ where: { sourceRef: `loanpay:${pay.id}` } });
  assert.deepEqual([item!.kind, Number(item!.amount), ymd(item!.expectedDate!)], ['CHECK', 4552.08, ymd(ago(3))]);
  assert.match(item!.description, /Check #1311/);
  // The amount corrected: the pending item follows.
  await send('PATCH', `/loans/${ids.loan}/payments/${pay.id}`, { amount: 4500 });
  item = await db.pendingOutflow.findFirst({ where: { sourceRef: `loanpay:${pay.id}` } });
  assert.equal(Number(item!.amount), 4500);
  // It has come out after all: no longer pending.
  await send('PATCH', `/loans/${ids.loan}/payments/${pay.id}`, { pendingFrom: null });
  assert.equal(await db.pendingOutflow.count({ where: { sourceRef: `loanpay:${pay.id}` } }), 0);
  // Another account's payment id is not found.
  assert.equal((await send('PATCH', `/loans/${ids.loan}/payments/not-a-payment`, { amount: 1 })).status, 404);
});
