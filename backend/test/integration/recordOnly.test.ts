/** A payment logged "record only" leaves the back-rent balance as the owner has it. */
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
  const u = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'A' } });
  const lease = await db.lease.create({ data: { unitId: u.id, rentAmount: 1000, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2026-01-01'), arrearsBalance: 5000, paymentsApplyTo: 'ARREARS', arrearsCaughtUpThrough: new Date('2026-10-01') } as any });
  ids.lease = lease.id;
});
after(async () => { if (!skip) await api.stop(); });

const send = (method: string, path: string, body?: unknown) => fetch(`${api.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const balance = async () => Number((await api.db.lease.findUnique({ where: { id: ids.lease } }))!.arrearsBalance);

test('record only: logged, balance untouched; switched to it, untouched; switched back, taken off', { skip }, async () => {
  const r = await send('POST', '/rent-payments', { leaseId: ids.lease, periodDate: '2026-06-01', paidDate: '2026-06-03', amount: 400, method: 'ZELLE', applyTo: 'HISTORY' });
  assert.equal(r.status, 201);
  assert.equal(await balance(), 5000);

  const normal = await (await send('POST', '/rent-payments', { leaseId: ids.lease, periodDate: '2026-10-01', paidDate: '2026-10-05', amount: 300, method: 'ZELLE' })).json() as any;
  assert.equal(await balance(), 4700);
  await send('PATCH', `/rent-payments/${normal.id}`, { applyTo: 'HISTORY' });
  assert.equal(await balance(), 4700, 'the owner keeps the balance they have');
  await send('PATCH', `/rent-payments/${normal.id}`, { applyTo: 'ARREARS' });
  assert.equal(await balance(), 4400);
});
