/**
 * A transfer for more than the month's rent: with nothing else owed the
 * extra is next month's rent (and the owner is told); with back rent owed,
 * the owner chooses — Apply answers 409 with the plan until they do.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const day = new Date('2026-11-01T00:00:00Z');

before(async () => {
  if (skip) return;
  api = await startApi();
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const u1 = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'Suite A' } });
  const u2 = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'Suite B' } });
  const clear = await db.lease.create({ data: { unitId: u1.id, rentAmount: 2900, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2025-01-01'), arrearsBalance: 0 } });
  const behind = await db.lease.create({ data: { unitId: u2.id, rentAmount: 2000, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2025-01-01'), arrearsBalance: 500 } });
  const tx = (id: string, leaseId: string, amount: number) => db.incomingTransaction.create({ data: { userId: me.id, plaidTransactionId: id, amount, date: day, name: 'SAMPLE PAYER', source: 'email', channel: 'ZELLE', memo: 'rent', status: 'SUGGESTED', matchedLeaseId: leaseId } });
  Object.assign(ids, { clear: clear.id, behind: behind.id, t1: (await tx('email:over1', clear.id, 3900)).id, t2: (await tx('email:over2', behind.id, 2600)).id });
});
after(async () => { if (!skip) await api.stop(); });

const apply = (id: string, body: unknown = {}) => fetch(`${api.url}/api/transactions/${id}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('nothing else owed: the extra is next month\'s rent', { skip }, async () => {
  assert.equal((await apply(ids.t1)).status, 200);
  const pays = await api.db.rentPayment.findMany({ where: { leaseId: ids.clear }, orderBy: { periodDate: 'asc' } });
  assert.deepEqual(pays.map(p => [p.periodDate.toISOString().slice(0, 7), Number(p.amount)]), [['2026-11', 2900], ['2026-12', 1000]]);
  const tx = await api.db.incomingTransaction.findUnique({ where: { id: ids.t1 } });
  assert.equal(tx!.status, 'APPLIED');
  assert.match(tx!.reviewNote ?? '', /December 2026/);
});

test('back rent owed: the owner chooses, then it goes where they said', { skip }, async () => {
  const r = await apply(ids.t2);
  assert.equal(r.status, 409);
  const body = await r.json() as any;
  assert.equal(body.plan.extra, 600);
  assert.equal(await api.db.rentPayment.count({ where: { leaseId: ids.behind } }), 0);
  assert.equal((await apply(ids.t2, { extraTo: 'arrears' })).status, 200);
  const lease = await api.db.lease.findUnique({ where: { id: ids.behind } });
  assert.equal(Number(lease!.arrearsBalance), 0);
});
