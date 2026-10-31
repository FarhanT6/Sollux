/**
 * "This month first" on a month that already ended: the payment is that
 * month's rent (not "to arrears"), and it still comes off the balance the
 * month's unpaid rent was rolled into. Deleting it puts the balance back.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, type TestApi } from './server';

let api: TestApi;
let leaseId = '';

before(async () => {
  if (skip) return;
  api = await startApi();
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const u = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'Unit C' } });
  // September has ended and rolled in: its $2,100 is in the balance, with $700 from before.
  const l = await db.lease.create({ data: { unitId: u.id, rentAmount: 2100, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2025-01-01'), arrearsBalance: 2800, arrearsCaughtUpThrough: new Date('2026-09-01') } });
  leaseId = l.id;
});
after(async () => { if (!skip) await api.stop(); });

const post = (body: unknown) => fetch(`${api.url}/api/rent-payments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const balance = async () => Number((await api.db.lease.findUnique({ where: { id: leaseId } }))!.arrearsBalance);

test('a late payment toward an ended month, this month first, is that month\'s rent', { skip }, async () => {
  const r = await post({ leaseId, periodDate: '2026-09-01T00:00:00.000Z', amount: 1600, paidDate: '2026-10-30', method: 'CASH', applyTo: 'CURRENT' });
  assert.equal(r.status, 201);
  const pay = await r.json() as any;
  assert.equal(Number(pay.appliedToArrears), 0);
  assert.equal(Number(pay.settledRolledRent), 1600);
  assert.equal(await balance(), 1200);
  // Deleting it puts the balance back.
  assert.equal((await fetch(`${api.url}/api/rent-payments/${pay.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(await balance(), 2800);
});

test('more than the month owes goes on to the earlier balance', { skip }, async () => {
  const pay = await (await post({ leaseId, periodDate: '2026-09-01T00:00:00.000Z', amount: 2500, paidDate: '2026-10-30', method: 'CASH', applyTo: 'CURRENT' })).json() as any;
  assert.equal(Number(pay.settledRolledRent), 2100);
  assert.equal(Number(pay.appliedToArrears), 400);
  assert.equal(await balance(), 300);
});

test('arrears first still goes to the balance', { skip }, async () => {
  const pay = await (await post({ leaseId, periodDate: '2026-09-01T00:00:00.000Z', amount: 200, paidDate: '2026-10-31', method: 'CASH', applyTo: 'ARREARS' })).json() as any;
  assert.equal(Number(pay.appliedToArrears), 200);
  assert.equal(Number(pay.settledRolledRent), 0);
  assert.equal(await balance(), 100);
});
