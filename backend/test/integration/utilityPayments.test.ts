/**
 * A tenant paying back utilities: Apply as utilities records it on the open
 * invoice, and the auto-log sends an exact invoice amount from the tenant
 * there on its own.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
let autoLogIncoming: typeof import('../../src/services/incomingRent').autoLogIncoming;

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  ({ autoLogIncoming } = await import('../../src/services/incomingRent'));
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const u = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'Main' } });
  const l = await db.lease.create({ data: { unitId: u.id, rentAmount: 5000, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2025-01-01'), arrearsBalance: 0 } });
  const r = await db.utilityReimbursement.create({ data: { leaseId: l.id, enabled: true, rulesJson: [] } });
  const inv1 = await db.reimbursementInvoice.create({ data: { reimbursementId: r.id, periodStart: new Date('2026-08-01'), periodEnd: new Date('2026-08-31'), subtotal: 906.3, total: 906.3, status: 'SENT' } });
  const inv2 = await db.reimbursementInvoice.create({ data: { reimbursementId: r.id, periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-09-30'), subtotal: 412.15, total: 412.15, status: 'SENT' } });
  const tx = (id: string, amount: number, memo: string | null) => db.incomingTransaction.create({ data: { userId: me.id, plaidTransactionId: id, amount, date: new Date('2026-10-09T00:00:00Z'), name: 'SAMPLE PAYER', source: 'email', channel: 'ZELLE', memo, status: 'SUGGESTED', matchedLeaseId: l.id } });
  // July's invoice, already paid by hand with $300.
  const inv3 = await db.reimbursementInvoice.create({ data: { reimbursementId: r.id, periodStart: new Date('2026-07-01'), periodEnd: new Date('2026-07-31'), subtotal: 300, total: 300, status: 'SENT' } });
  const { payInvoice } = await import('../../src/services/reimbursement');
  await payInvoice(inv3.id, me.id, { amount: 300, paidAt: '2026-08-10', method: 'CASH' });
  ids.inv3 = inv3.id;
  ids.t3 = (await tx('email:u3', 300, 'july utilities')).id;
  Object.assign(ids, { user: me.id, lease: l.id, inv1: inv1.id, inv2: inv2.id, t1: (await tx('email:u1', 906.3, 'Utilities')).id, t2: (await tx('email:u2', 412.15, null)).id });
});
after(async () => { if (!skip) await api.stop(); });

test('Apply as utilities records it on the invoice it pays', { skip }, async () => {
  const r = await fetch(`${api.url}/api/transactions/${ids.t1}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as: 'utilities' }) });
  assert.equal(r.status, 200);
  const inv = await api.db.reimbursementInvoice.findUnique({ where: { id: ids.inv1 } });
  assert.equal(Number(inv!.paidAmount), 906.3);
  assert.equal(await api.db.rentPayment.count({ where: { leaseId: ids.lease } }), 0);
});

test('an exact invoice amount from the tenant is logged to that invoice on its own', { skip }, async () => {
  const did = await autoLogIncoming({ txId: ids.t2, userId: ids.user, leaseId: ids.lease, amount: 412.15, date: new Date('2026-10-09T00:00:00Z'), memo: null, method: 'ZELLE', notes: 'test' }, true);
  assert.equal(did, 'utilities');
  const inv = await api.db.reimbursementInvoice.findUnique({ where: { id: ids.inv2 } });
  assert.equal(Number(inv!.paidAmount), 412.15);
  assert.equal((await api.db.incomingTransaction.findUnique({ where: { id: ids.t2 } }))!.status, 'APPLIED');
});

test('a paid invoice picked: this payment replaces the one that closed it', { skip }, async () => {
  const r = await fetch(`${api.url}/api/transactions/${ids.t3}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as: 'utilities', invoiceId: ids.inv3 }) });
  assert.equal(r.status, 200);
  const inv = await api.db.reimbursementInvoice.findUnique({ where: { id: ids.inv3 } });
  assert.equal(Number(inv!.paidAmount), 300);
  assert.equal(inv!.status, 'PAID');
  const pays = await api.db.reimbursementPayment.findMany({ where: { invoiceId: ids.inv3 } });
  assert.deepEqual(pays.map(p => [p.method, Number(p.amount)]), [['ZELLE', 300]]);
});
