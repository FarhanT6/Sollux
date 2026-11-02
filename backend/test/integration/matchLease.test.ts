/**
 * The tenant a payer name points to: a whole name wins over a surname that
 * other tenants share; two equal fits are not guessed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
let matchLease: typeof import('../../src/services/transactionMatchService').matchLease;
const ids: Record<string, string> = {};

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  ({ matchLease } = await import('../../src/services/transactionMatchService'));
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const lease = async (label: string, name: string) => {
    const u = await db.unit.create({ data: { propertyId: p.id, unitLabel: label } });
    const l = await db.lease.create({ data: { unitId: u.id, rentAmount: 1300, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2025-01-01') } });
    const t = await db.tenant.create({ data: { userId: me.id, fullName: name } });
    await db.leaseTenant.create({ data: { leaseId: l.id, tenantId: t.id } });
    return l.id;
  };
  ids.user = me.id;
  ids.jane = await lease('A', 'Jane Sample');
  ids.mark = await lease('B', 'Mark Sample');
});
after(async () => { if (!skip) await api.stop(); });

test('a whole name wins over a shared surname', { skip }, async () => {
  const m = await matchLease('JANE SAMPLE', ids.user);
  assert.equal(m?.leaseId, ids.jane);
  assert.equal(m?.exact, true);
});

test('only the shared surname: two leases fit, none is guessed', { skip }, async () => {
  assert.equal(await matchLease('SAMPLE', ids.user), null);
});
