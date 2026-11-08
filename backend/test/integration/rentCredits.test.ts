/** A credit toward rent: counts toward rent, records the property expense the tenant paid, and a concession is not income. */
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
  const lease = await db.lease.create({ data: { unitId: u.id, rentAmount: 1000, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2026-01-01') } as any });
  ids.lease = lease.id; ids.property = p.id;
});
after(async () => { if (!skip) await api.stop(); });

const send = (method: string, path: string, body?: unknown) => fetch(`${api.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('a repair credit records the expense; a concession is not income; deleting removes the expense', { skip }, async () => {
  const bad = await send('POST', '/rent-payments', { leaseId: ids.lease, periodDate: '2026-10-01', paidDate: '2026-10-05', amount: 300, method: 'CREDIT', creditFor: 'REPAIR' });
  assert.equal(bad.status, 400, 'a credit says what it was for');

  const r = await send('POST', '/rent-payments', { leaseId: ids.lease, periodDate: '2026-10-01', paidDate: '2026-10-05', amount: 300, method: 'CREDIT', creditFor: 'REPAIR', notes: 'replaced the water heater', status: 'PENDING' });
  assert.equal(r.status, 201);
  const repair = await r.json() as any;
  assert.equal(repair.status, 'RECEIVED');
  assert.equal(repair.notIncome, false);
  const exp = await api.db.expense.findUnique({ where: { id: repair.expenseId } });
  assert.equal(exp?.category, 'REPAIRS_MAINTENANCE');
  assert.equal(Number(exp?.amount), 300);
  assert.equal(exp?.propertyId, ids.property);

  const c = await (await send('POST', '/rent-payments', { leaseId: ids.lease, periodDate: '2026-11-01', paidDate: '2026-11-01', amount: 500, method: 'CREDIT', creditFor: 'CONCESSION', notes: 'half off November' })).json() as any;
  assert.equal(c.notIncome, true);
  assert.equal(c.expenseId, null);

  await send('PATCH', `/rent-payments/${repair.id}`, { amount: 350 });
  assert.equal(Number((await api.db.expense.findUnique({ where: { id: repair.expenseId } }))?.amount), 350, 'the expense follows the credit');
  assert.equal((await send('DELETE', `/rent-payments/${repair.id}`)).status, 204);
  assert.equal(await api.db.expense.findUnique({ where: { id: repair.expenseId } }), null);
});
