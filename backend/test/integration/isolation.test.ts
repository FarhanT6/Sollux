/**
 * One customer never sees or changes another's data: the signed-in owner
 * asks for the other customer's records by id and must get 404, and lists
 * must not include them.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, type TestApi } from './server';

let api: TestApi;
const other: Record<string, string> = {};

before(async () => {
  if (skip) return;
  api = await startApi();
  const { db } = api;
  const trial = new Date(Date.now() + 10 * 86_400_000);
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: trial } });
  await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  // Another customer, with one of everything.
  const o = await db.user.create({ data: { email: 'other@example.com', fullName: 'Other Customer', clerkUserId: 'user_other', trialEndsAt: trial } });
  const p = await db.property.create({ data: { userId: o.id, address: '9 Other St', city: 'Elsewhere', state: 'TX', zip: '75001', type: 'RESIDENTIAL_SINGLE' } });
  const a = await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Other Water', providerSlug: 'other-water', category: 'WATER' } });
  const s = await db.statement.create({ data: { utilityAccountId: a.id, statementDate: new Date('2026-10-01'), amountDue: 120 } });
  const pay = await db.payment.create({ data: { utilityAccountId: a.id, statementId: s.id, amount: 120, paymentDate: new Date('2026-10-10') } });
  const t = await db.tenant.create({ data: { userId: o.id, fullName: 'Other Tenant' } });
  await db.aiUsage.create({ data: { feature: 'portal-agent', model: 'claude-sonnet-5', userId: o.id, costUsd: 4.5, inputTokens: 1000, outputTokens: 100 } });
  Object.assign(other, { property: p.id, account: a.id, statement: s.id, payment: pay.id, tenant: t.id });
});
after(async () => { if (!skip) await api.stop(); });

const get = (path: string) => fetch(`${api.url}/api${path}`);
const send = (method: string, path: string, body?: unknown) => fetch(`${api.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('property list shows only my properties', { skip }, async () => {
  const list = await (await get('/properties')).json() as any[];
  assert.equal(list.length, 1);
  assert.ok(!list.some(p => p.id === other.property));
});

test("another customer's property, account and tenant are not found", { skip }, async () => {
  assert.equal((await get(`/properties/${other.property}`)).status, 404);
  assert.equal((await get(`/utilities/${other.account}`)).status, 404);
  const tenants = await (await get('/tenants')).json() as any[];
  assert.ok(!tenants.some(t => t.id === other.tenant));
});

test("another customer's statement and payment cannot be changed or deleted", { skip }, async () => {
  assert.equal((await send('PATCH', `/statements/${other.statement}`, { amountDue: 1 })).status, 404);
  assert.equal((await send('DELETE', `/payments/${other.payment}`)).status, 404);
  const s = await api.db.statement.findUnique({ where: { id: other.statement } });
  assert.equal(Number(s?.amountDue), 120);
  assert.ok(await api.db.payment.findUnique({ where: { id: other.payment } }));
});

test("AI usage shows my account's spend, not another customer's", { skip }, async () => {
  const r = await (await get('/ai-spend')).json() as any;
  assert.equal(r.scope, 'account');
  assert.equal(r.spent, 0);
  assert.equal(r.recent.length, 0);
});
