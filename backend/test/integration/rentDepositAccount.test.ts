/**
 * Editing which account a rent check went into: it leaves the deposit slip it was in, its pending
 * deposit follows it to the new account on the same deposit day, and "on hand" again means not
 * deposited at all. Made-up tenant, accounts and amounts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const DAY = 86_400_000;

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * DAY) } as any });
  ids.user = me.id;
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } as any });
  const u = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'A' } });
  const lease = await db.lease.create({ data: { unitId: u.id, rentAmount: 900, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2025-01-01') } as any });
  ids.a = (await db.bankAccount.create({ data: { userId: me.id, name: 'Business Checking', bank: 'Example Bank', last4: '1111', accountType: 'CHECKING' } as any })).id;
  ids.b = (await db.bankAccount.create({ data: { userId: me.id, name: 'Everyday Checking', bank: 'Example Bank', last4: '2222', accountType: 'CHECKING' } as any })).id;
  const day = new Date(Date.now() - 2 * DAY);
  const first = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  ids.check = (await db.rentPayment.create({ data: { leaseId: lease.id, amount: 900, periodDate: first, paidDate: day, method: 'MONEY_ORDER', status: 'RECEIVED' } as any })).id;
  ids.other = (await db.rentPayment.create({ data: { leaseId: lease.id, amount: 450, periodDate: first, paidDate: day, method: 'CHECK', status: 'RECEIVED', notes: 'part' } as any })).id;
  // Both deposited together from Cash, checks & apps: one slip of 1,350 into ··1111, yesterday.
  const { depositChecks } = await import('../../src/services/wallets');
  await depositChecks(me.id, [ids.check, ids.other], ids.a, new Date(Date.now() - DAY));
});
after(async () => { if (!skip) await api.stop(); });

const patch = (id: string, body: unknown) => fetch(`${api.url}/api/rent-payments/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const pendingIn = () => api.db.pendingOutflow.findMany({ where: { userId: ids.user, cleared: false, direction: 'IN' }, orderBy: { amount: 'asc' } });

test('moved to another account: out of the slip, pending on the new account on the same day', { skip }, async () => {
  const before = await api.db.rentPayment.findUnique({ where: { id: ids.check } });
  const r = await patch(ids.check, { bankAccountId: ids.b });
  assert.equal(r.status, 200, await r.text());
  const rows = await pendingIn();
  assert.deepEqual(rows.map(p => [p.bankAccountId, Number(p.amount)]).sort(), [[ids.a, 450], [ids.b, 900]].sort());
  const moved = rows.find(p => p.bankAccountId === ids.b)!;
  assert.equal(moved.expectedDate?.toISOString().slice(0, 10), before!.depositedAt!.toISOString().slice(0, 10));
  const after = await api.db.rentPayment.findUnique({ where: { id: ids.check } });
  assert.equal(after!.depositedAt?.toISOString(), before!.depositedAt?.toISOString(), 'keeps its deposit day');
});

test('back on hand: not deposited, nothing pending for it', { skip }, async () => {
  const r = await patch(ids.check, { bankAccountId: null });
  assert.equal(r.status, 200, await r.text());
  const p = await api.db.rentPayment.findUnique({ where: { id: ids.check } });
  assert.equal(p!.bankAccountId, null);
  assert.equal(p!.depositedAt, null);
  assert.deepEqual((await pendingIn()).map(x => [x.bankAccountId, Number(x.amount)]), [[ids.a, 450]]);
});

test('the payment list says where each went', { skip }, async () => {
  const list = await fetch(`${api.url}/api/rent-payments`).then(r => r.json()) as any[];
  const other = list.find(p => p.id === ids.other);
  assert.equal(other.bankAccount?.last4, '1111');
  assert.ok(other.depositedAt);
});
