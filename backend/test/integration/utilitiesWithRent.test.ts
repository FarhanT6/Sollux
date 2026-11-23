/**
 * A tenant who pays the utilities back with the rent (made-up tenants and figures): what they send
 * over the rent is utilities, not next month's rent, and a second payment in a month is not moved
 * on to the next month. A tenant with no such habit still has an extra put on next month.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const month = (offset: number, day = 1) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + offset, day));
const ym = (d: Date) => d.toISOString().slice(0, 7);

before(async () => {
  if (skip) return;
  api = await startApi();
  // The paid-ahead cleanup is called here directly, on the test database.
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_MULTI' } });
  const u1 = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'Space 1' } });
  const u2 = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'Space 2' } });
  const payer = await db.lease.create({ data: { unitId: u1.id, rentAmount: 800, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: month(-8), arrearsBalance: 0 } });
  const plain = await db.lease.create({ data: { unitId: u2.id, rentAmount: 800, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: month(-8), arrearsBalance: 0 } });
  // Four months of rent plus utilities from the first tenant, as rent rows of more than the rent.
  for (let i = -4; i <= -1; i++) {
    await db.rentPayment.create({ data: { leaseId: payer.id, periodDate: month(i), paidDate: month(i, 10), amount: 1_050, method: 'ZELLE', status: 'RECEIVED' } });
  }
  const tx = (id: string, lease: string, amount: number, day: number) => db.incomingTransaction.create({
    data: { userId: me.id, plaidTransactionId: `bank:${id}`, amount, date: month(0, day), name: `ZELLE FROM SAMPLE ${id.toUpperCase()}`, source: 'bank', channel: 'ZELLE', status: 'SUGGESTED', matchedLeaseId: lease },
  });
  const a = await tx('a', payer.id, 1_150, 2);
  const b = await tx('b', payer.id, 300, 3);
  const c = await tx('c', plain.id, 900, 2);
  // An extra Sollux once put on next month for the first tenant.
  const ahead = await db.rentPayment.create({ data: { leaseId: payer.id, periodDate: month(2), paidDate: month(-1, 26), amount: 120, method: 'ZELLE', status: 'RECEIVED', notes: 'Matched from ZELLE transaction · paid ahead: $120.00 over a month\'s rent' } });
  Object.assign(ids, { me: me.id, payer: payer.id, plain: plain.id, a: a.id, b: b.id, c: c.id, ahead: ahead.id });
});
after(async () => { if (!skip) await api.stop(); });

const apply = (id: string) => fetch(`${api.url}/api/transactions/${id}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

test("a utility payer's extra over the rent is utilities, not next month's rent", { skip }, async () => {
  assert.equal((await apply(ids.a)).status, 200);
  const rent = await api.db.rentPayment.findMany({ where: { leaseId: ids.payer, paidDate: { gte: month(0) } } });
  assert.deepEqual(rent.map(r => [ym(r.periodDate), Number(r.amount)]), [[ym(month(0)), 800]]);
  const utils = await api.db.reimbursementPayment.findMany({ where: { leaseId: ids.payer } });
  assert.deepEqual(utils.map(u => Number(u.amount)), [350]);
});

test('a second payment in a month already paid is utilities, not next month', { skip }, async () => {
  assert.equal((await apply(ids.b)).status, 200);
  const next = await api.db.rentPayment.findMany({ where: { leaseId: ids.payer, periodDate: month(1) } });
  assert.equal(next.length, 0);
  const utils = await api.db.reimbursementPayment.findMany({ where: { leaseId: ids.payer }, orderBy: { paidDate: 'asc' } });
  assert.deepEqual(utils.map(u => Number(u.amount)), [350, 300]);
});

test('a tenant with no such habit: the extra is still next month', { skip }, async () => {
  assert.equal((await apply(ids.c)).status, 200);
  const rent = await api.db.rentPayment.findMany({ where: { leaseId: ids.plain }, orderBy: { periodDate: 'asc' } });
  assert.deepEqual(rent.map(r => [ym(r.periodDate), Number(r.amount)]), [[ym(month(0)), 800], [ym(month(1)), 100]]);
});

test('paid-ahead extras of a utility payer move to utilities; "It was utilities" moves one by hand', { skip }, async () => {
  const { movePaidAheadToUtilities } = await import('../../src/services/incomingRent');
  assert.equal(await movePaidAheadToUtilities(), 1);
  assert.equal(await api.db.rentPayment.findUnique({ where: { id: ids.ahead } }), null);
  // The other tenant's next-month extra is not a utility payer's: it stays.
  assert.equal(await api.db.rentPayment.count({ where: { leaseId: ids.plain, periodDate: month(1) } }), 1);
  const plainNext = await api.db.rentPayment.findFirstOrThrow({ where: { leaseId: ids.plain, periodDate: month(1) } });
  const r = await fetch(`${api.url}/api/rent-payments/${plainNext.id}/utilities`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(await api.db.rentPayment.count({ where: { leaseId: ids.plain, periodDate: month(1) } }), 0);
  assert.equal(await api.db.reimbursementPayment.count({ where: { leaseId: ids.plain } }), 1);
});
