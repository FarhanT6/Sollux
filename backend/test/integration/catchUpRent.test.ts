/**
 * Rent caught up through a month: only active leases with no arrears, from
 * move-in, never over a logged payment; undone in one stroke. And a loan
 * payment logged twice is refused unless the owner says it is a second one.
 */
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
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_MULTI' } });
  const u1 = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'A' } });
  const u2 = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'B' } });
  const clean = await db.lease.create({ data: { unitId: u1.id, rentAmount: 1000, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2026-07-01'), arrearsBalance: 0 } });
  await db.rentPayment.create({ data: { leaseId: clean.id, periodDate: new Date('2026-08-01'), amount: 400, paidDate: new Date('2026-08-03'), method: 'CASH', status: 'RECEIVED' } });
  const behind = await db.lease.create({ data: { unitId: u2.id, rentAmount: 1500, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2026-01-01'), arrearsBalance: 4500 } });
  const loan = await db.loan.create({ data: { userId: me.id, lender: 'Example Bank', loanType: 'MORTGAGE', monthlyPayment: 2000, isActive: true } });
  Object.assign(ids, { clean: clean.id, behind: behind.id, loan: loan.id });
});
after(async () => { if (!skip) await api.stop(); });

const send = (method: string, path: string, body?: unknown) => fetch(`${api.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('rent caught up from move-in, around the logged month, arrears left to the owner', { skip }, async () => {
  const preview = await (await send('GET', '/catch-up/rent?through=2026-09')).json() as any;
  const lease = preview.ready.find((l: any) => l.leaseId === ids.clean);
  assert.deepEqual(lease.months.map((m: any) => m.month), ['2026-07', '2026-09']);
  assert.ok(!preview.ready.some((l: any) => l.leaseId === ids.behind));
  assert.equal(preview.review.find((l: any) => l.leaseId === ids.behind)?.arrears, 4500);

  const r = await (await send('POST', '/catch-up/rent', { through: '2026-09', leaseIds: [ids.clean, ids.behind] })).json() as any;
  assert.equal(r.rentPayments, 2);
  assert.equal(await api.db.rentPayment.count({ where: { leaseId: ids.behind } }), 0);
  const aug = await api.db.rentPayment.findMany({ where: { leaseId: ids.clean, periodDate: new Date('2026-08-01') } });
  assert.equal(aug.length, 1); // the logged part payment, untouched

  assert.equal((await send('POST', '/catch-up/rent/undo')).status, 200);
  assert.equal(await api.db.rentPayment.count({ where: { leaseId: ids.clean } }), 1);
});

test('a loan payment logged twice is refused unless it is a second one', { skip }, async () => {
  const pay = { date: '2026-10-12', amount: 2000 };
  assert.equal((await send('POST', `/loans/${ids.loan}/payments`, pay)).status, 201);
  const again = await send('POST', `/loans/${ids.loan}/payments`, pay);
  assert.equal(again.status, 409);
  assert.equal((await again.json() as any).duplicate, true);
  assert.equal((await send('POST', `/loans/${ids.loan}/payments`, { ...pay, allowDuplicate: true })).status, 201);
});
