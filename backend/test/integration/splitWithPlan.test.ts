/**
 * One payment that is this month's bill plus the payment arrangement's installment (and its fee):
 * logged as a split with the arrangement as one part. Made-up HOA account and amounts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const post = (path: string, body: unknown) => fetch(`${api.url}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } as any });
  const prop = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const acct = await db.utilityAccount.create({ data: { propertyId: prop.id, providerName: 'Example HOA', providerSlug: 'gmail-fallback', category: 'HOA', billingCadence: 'MONTHLY', accountNumber: '7777' } as any });
  ids.acct = acct.id;
  ids.oct = (await db.statement.create({ data: { utilityAccountId: acct.id, statementDate: new Date('2026-09-20T00:00:00Z'), dueDate: new Date('2026-10-01T00:00:00Z'), amountDue: 1100, rawDataJson: { source: 'pdf_import' } } as any })).id;
  ids.plan = (await db.paymentPlan.create({ data: { utilityAccountId: acct.id, totalAmount: 6000, remainingBalance: 3000, monthlyAmount: 600, installmentFee: 30, startDate: new Date('2026-05-01T00:00:00Z'), status: 'ACTIVE' } })).id;
});
after(async () => { if (!skip) await api.stop(); });

test("the month's bill and the arrangement's installment, paid as one", { skip }, async () => {
  const r = await post('/payments/split', {
    utilityAccountId: ids.acct, amount: 1730, paymentDate: '2026-11-03', paymentMethod: 'ACH', status: 'PAID',
    allocations: [{ statementId: ids.oct, amount: 1100 }, { statementId: null, towardPlan: true, amount: 630 }],
  });
  assert.equal(r.status, 201);
  const parts = await api.db.payment.findMany({ where: { utilityAccountId: ids.acct }, orderBy: { amount: 'asc' } });
  assert.equal(parts.length, 2);
  assert.equal(parts[0].splitGroupId, parts[1].splitGroupId);
  const planPart = parts.find(p => p.towardPlan)!;
  assert.equal(planPart.statementId, null);
  assert.equal(Number(planPart.amount), 630);
  // The installment less its fee comes off the plan; the bill is paid.
  assert.equal(Number((await api.db.paymentPlan.findUniqueOrThrow({ where: { id: ids.plan } })).remainingBalance), 2400);
  assert.equal(Number((await api.db.statement.findUniqueOrThrow({ where: { id: ids.oct } })).amountPaid), 1100);
});

test('a part is a bill or the arrangement', { skip }, async () => {
  const r = await post('/payments/split', {
    utilityAccountId: ids.acct, amount: 200, paymentDate: '2026-11-03', status: 'PAID',
    allocations: [{ statementId: ids.oct, amount: 100 }, { statementId: null, amount: 100 }],
  });
  assert.equal(r.status >= 400, true);
});
