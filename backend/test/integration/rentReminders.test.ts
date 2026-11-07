/** One open rent reminder per tenant, and none once the rent is paid. */
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
  const paid = await db.lease.create({ data: { unitId: u1.id, rentAmount: 1000, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2026-01-01'), arrearsBalance: 0 } });
  const twice = await db.lease.create({ data: { unitId: u2.id, rentAmount: 1500, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2026-01-01'), arrearsBalance: 0 } });
  const draft = (leaseId: string, key: string, kind: string, amountDue: number, createdAt: string) =>
    db.messageDraft.create({ data: { userId: me.id, leaseId, kind, body: 'x', amountDue, dedupeKey: `rent:${leaseId}:${key}:${kind}`, createdAt: new Date(createdAt) } });
  await draft(paid.id, '2026-11', 'REMINDER', 1000, '2026-11-06');
  await db.rentPayment.create({ data: { leaseId: paid.id, periodDate: new Date('2026-11-01'), amount: 1000, paidDate: new Date('2026-11-07'), method: 'ZELLE', status: 'RECEIVED' } });
  await draft(twice.id, '2026-11', 'REMINDER', 1500, '2026-11-06');
  const firm = await draft(twice.id, '2026-11', 'FIRM', 1500, '2026-11-09');
  Object.assign(ids, { paid: paid.id, twice: twice.id, firm: firm.id });
});
after(async () => { if (!skip) await api.stop(); });

test('the list shows one reminder for the tenant who still owes, none for the one who paid', { skip }, async () => {
  const list = await (await fetch(`${api.url}/api/message-drafts`)).json() as any[];
  assert.deepEqual(list.map(d => d.id), [ids.firm]);
  const statuses = (await api.db.messageDraft.findMany({ orderBy: { createdAt: 'asc' } })).map(d => d.status);
  assert.deepEqual(statuses.sort(), ['DRAFT', 'MERGED', 'PAID']);
});
