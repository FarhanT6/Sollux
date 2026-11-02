/** A new tenant's deposit sent with the first rent: Apply as rent + deposit splits it. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};

before(async () => {
  if (skip) return;
  api = await startApi();
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const u = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'Space 9' } });
  const l = await db.lease.create({ data: { unitId: u.id, rentAmount: 750, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date(Date.now() - 20 * 86_400_000), arrearsBalance: 0 } });
  const tx = await db.incomingTransaction.create({ data: { userId: me.id, plaidTransactionId: 'bank:dep1', amount: 1500, date: new Date(), name: 'ZELLE FROM SAMPLE PAYER', source: 'bank', channel: 'ZELLE', status: 'SUGGESTED', matchedLeaseId: l.id } });
  Object.assign(ids, { lease: l.id, tx: tx.id });
});
after(async () => { if (!skip) await api.stop(); });

test('the list suggests the deposit for a new lease with none on record', { skip }, async () => {
  const list = await (await fetch(`${api.url}/api/transactions?status=SUGGESTED`)).json() as any[];
  const row = list.find(t => t.id === ids.tx);
  assert.equal(row.deposit.suggested, true);
  assert.equal(row.deposit.amount, 750);
});

test('rent + deposit: the deposit to the lease, the rest as rent', { skip }, async () => {
  const r = await fetch(`${api.url}/api/transactions/${ids.tx}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as: 'deposit', depositAmount: 750 }) });
  assert.equal(r.status, 200);
  const deps = await api.db.leaseDeposit.findMany({ where: { leaseId: ids.lease } });
  assert.deepEqual(deps.map(d => Number(d.amount)), [750]);
  const pays = await api.db.rentPayment.findMany({ where: { leaseId: ids.lease } });
  assert.deepEqual(pays.map(p => Number(p.amount)), [750]);
  assert.match((await api.db.incomingTransaction.findUnique({ where: { id: ids.tx } }))!.reviewNote ?? '', /security deposit/);
});
