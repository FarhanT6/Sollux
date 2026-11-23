/**
 * A loan payment that came back (a bounced check): the month is owed again, plus the lender's fee;
 * the bank's fee is an expense; the pending item goes; Undo puts it all back. Made-up loan.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const j = (path: string, body?: unknown) => fetch(`${api.url}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } as any });
  ids.user = me.id;
  const prop = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  ids.bank = (await db.bankAccount.create({ data: { userId: me.id, name: 'Example Checking', bank: 'Example Bank', last4: '1234', accountType: 'CHECKING' } as any })).id;
  ids.loan = (await db.loan.create({ data: { userId: me.id, propertyId: prop.id, lender: 'Example Trustee', loanType: 'SELLER_FINANCING', originalAmount: 500000, monthlyPayment: 1000, dueDay: 1, gracePeriodDays: 10, originationDate: new Date('2025-01-01T00:00:00Z') } as any })).id;
});
after(async () => { if (!skip) await api.stop(); });

const novRow = async () => {
  const r = await j(`/loans/tracker?month=2026-11&today=2026-11-23`);
  return ((await r.json()) as any).rows.find((x: any) => x.loanId === ids.loan);
};

test("a bounced check: owed again with the lender's fee, the bank's fee an expense, pending gone", { skip }, async () => {
  const created = await j(`/loans/${ids.loan}/payments`, { date: '2026-11-03', amount: 1000, method: 'CHECK', confirmationNumber: '1001', periodMonth: '2026-11', pendingFrom: ids.bank });
  assert.equal(created.status, 201);
  ids.pay = ((await created.json()) as any).id;
  assert.equal((await novRow()).status, 'paid');
  assert.equal(await api.db.pendingOutflow.count({ where: { userId: ids.user, sourceRef: `loanpay:${ids.pay}`, cleared: false } }), 1);

  const res = await j(`/loans/${ids.loan}/payments/${ids.pay}/returned`, { returnedOn: '2026-11-10', reason: 'NSF', bankFee: 35, lenderFee: 25 });
  assert.equal(res.status, 201);
  ids.returned = ((await res.json()) as any).id;

  const row = await novRow();
  assert.equal(row.status, 'late');
  assert.equal(row.paid, 0);
  assert.equal(row.expected, 1025);
  assert.equal(row.returned.length, 1);
  assert.equal(row.returned[0].bankFee, 35);
  assert.equal(await api.db.loanPayment.count({ where: { loanId: ids.loan } }), 0);
  assert.equal(await api.db.pendingOutflow.count({ where: { userId: ids.user, sourceRef: `loanpay:${ids.pay}` } }), 0);
  const fee = await api.db.expense.findFirstOrThrow({ where: { userId: ids.user } });
  assert.equal(Number(fee.amount), 35);
  assert.match(fee.description ?? '', /check to Example Trustee came back/);
});

test('undo puts the payment, its pending item and nothing else back', { skip }, async () => {
  const res = await j(`/loans/${ids.loan}/returned/${ids.returned}/undo`, {});
  assert.equal(res.status, 200);
  const row = await novRow();
  assert.equal(row.status, 'paid');
  assert.equal(row.expected, 1000);
  assert.equal(row.returned.length, 0);
  assert.equal(await api.db.expense.count({ where: { userId: ids.user } }), 0);
  const p = await api.db.loanPayment.findFirstOrThrow({ where: { loanId: ids.loan } });
  assert.equal(p.confirmationNumber, '1001');
  assert.equal(await api.db.pendingOutflow.count({ where: { userId: ids.user, sourceRef: `loanpay:${p.id}`, cleared: false } }), 1);
});
