/** A bill's "Payments Received" copy of a payment logged by hand later is removed; the owner's record stays. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
let dropStatementTwins: typeof import('../../src/services/statementPaymentTwins').dropStatementTwins;

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  ({ dropStatementTwins } = await import('../../src/services/statementPaymentTwins'));
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const a = await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample Hauling', providerSlug: 'sample', category: 'TRASH' } as any });
  await db.statement.create({ data: { utilityAccountId: a.id, statementDate: new Date('2026-09-03'), amountDue: 269.04 } as any });
  const oct = await db.statement.create({ data: { utilityAccountId: a.id, statementDate: new Date('2026-10-05'), amountDue: 276.82 } as any });
  const copy = await db.payment.create({ data: { utilityAccountId: a.id, amount: 238.2, paymentDate: new Date('2026-10-04'), status: 'PAID', notes: `Confirmed by the 2026-10-05 statement ("Payments Received"). [from-statement:${oct.id}]` } });
  const hand = await db.payment.create({ data: { utilityAccountId: a.id, amount: 238.2, paymentDate: new Date('2026-09-16'), status: 'PAID', paymentMethod: 'ACH', confirmationNumber: '123456' } });
  Object.assign(ids, { account: a.id, copy: copy.id, hand: hand.id });
});
after(async () => { if (!skip) await api.stop(); });

test('the copy goes, the hand-logged payment stays', { skip }, async () => {
  assert.equal(await dropStatementTwins(ids.account), 1);
  const left = await api.db.payment.findMany({ where: { utilityAccountId: ids.account } });
  assert.deepEqual(left.map(p => p.id), [ids.hand]);
});
