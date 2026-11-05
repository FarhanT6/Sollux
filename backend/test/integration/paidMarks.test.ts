/** A payment that covers a bill and what it carried in lifts the Unpaid marks on it and the bills before it. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
let lift: typeof import('../../src/services/paidMarks').liftMarksSettledBy;

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  ({ liftMarksSettledBy: lift } = await import('../../src/services/paidMarks'));
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const a = await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample Servicer', providerSlug: 'sample', category: 'OTHER' } as any });
  const mk = (d: string, amountDue: number, pastDueCarried: number | null) =>
    db.statement.create({ data: { utilityAccountId: a.id, statementDate: new Date(d), amountDue, pastDueCarried, paidOverride: 'UNPAID' } as any });
  const jul = await mk('2026-07-18', 40, null);
  const aug = await mk('2026-08-18', 20, 40);
  const sep = await mk('2026-09-17', 10, null);
  Object.assign(ids, { account: a.id, jul: jul.id, aug: aug.id, sep: sep.id });
});
after(async () => { if (!skip) await api.stop(); });

const marks = async () => Object.fromEntries((await api.db.statement.findMany({ where: { utilityAccountId: ids.account } }))
  .map(s => [s.id === ids.jul ? 'jul' : s.id === ids.aug ? 'aug' : 'sep', s.paidOverride]));

test('a part payment lifts only its own bill', { skip }, async () => {
  await api.db.payment.create({ data: { utilityAccountId: ids.account, statementId: ids.aug, amount: 30, paymentDate: new Date('2026-09-01'), status: 'PAID' } });
  await lift(ids.aug);
  assert.deepEqual(await marks(), { jul: 'UNPAID', aug: null, sep: 'UNPAID' });
});

test('covering the bill and its past due lifts the bills before it, not after', { skip }, async () => {
  await api.db.payment.create({ data: { utilityAccountId: ids.account, statementId: ids.aug, amount: 30, paymentDate: new Date('2026-09-10'), status: 'PAID' } });
  await lift(ids.aug);
  assert.deepEqual(await marks(), { jul: null, aug: null, sep: 'UNPAID' });
});
