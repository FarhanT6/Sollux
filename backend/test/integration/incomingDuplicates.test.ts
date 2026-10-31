/**
 * A transfer is logged as rent once: the bank row and the email of the same
 * Zelle (same reference) land on one payment, while two real same-amount
 * Zelles on one day each get their own; a deleted duplicate is not logged back.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
let findLoggedPayment: typeof import('../../src/services/p2pPaymentEmails').findLoggedPayment;
const ids: Record<string, string> = {};
const day = new Date('2026-09-30T00:00:00Z');

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  ({ findLoggedPayment } = await import('../../src/services/p2pPaymentEmails'));
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const u = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'Unit 2' } });
  const l = await db.lease.create({ data: { unitId: u.id, rentAmount: 3700, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2025-01-01') } });
  // One $1,000 Zelle already logged from its email (reference ABC111).
  const pay = await db.rentPayment.create({ data: { leaseId: l.id, amount: 1000, periodDate: new Date('2026-09-01'), paidDate: day, method: 'ZELLE' } });
  const tx = await db.incomingTransaction.create({ data: { userId: me.id, plaidTransactionId: 'email:one', amount: 1000, date: day, name: 'JANE SAMPLE', source: 'email', confirmation: 'ABC111', status: 'APPLIED', rentPaymentId: pay.id, matchedLeaseId: l.id } });
  Object.assign(ids, { lease: l.id, payment: pay.id, tx: tx.id });
});
after(async () => { if (!skip) await api.stop(); });

test('the bank row of a transfer already logged from its email finds that payment', { skip }, async () => {
  const hit = await findLoggedPayment(ids.lease, 1000, day, { source: 'bank', reference: 'abc111' });
  assert.equal(hit?.id, ids.payment);
  // No reference on the bank row: still the same transfer (the other source's copy).
  assert.equal((await findLoggedPayment(ids.lease, 1000, day, { source: 'bank' }))?.id, ids.payment);
});

test('a second real Zelle the same day is its own payment', { skip }, async () => {
  // Another reference: another transfer.
  assert.equal(await findLoggedPayment(ids.lease, 1000, day, { source: 'bank', reference: 'XYZ999' }), null);
  // Another email: another transfer.
  assert.equal(await findLoggedPayment(ids.lease, 1000, day, { source: 'email', reference: 'DEF222' }), null);
});

test('a payment logged by hand is found by either source', { skip }, async () => {
  const manual = await api.db.rentPayment.create({ data: { leaseId: ids.lease, amount: 600, periodDate: new Date('2026-09-01'), paidDate: day, method: 'ZELLE' } });
  assert.equal((await findLoggedPayment(ids.lease, 600, new Date('2026-10-02T00:00:00Z'), { source: 'bank', reference: 'R1' }))?.id, manual.id);
});

test('deleting a payment that came from a transfer leaves the transfer unmatched, not waiting to be logged again', { skip }, async () => {
  const r = await fetch(`${api.url}/api/rent-payments/${ids.payment}`, { method: 'DELETE' });
  assert.equal(r.status, 204);
  const tx = await api.db.incomingTransaction.findUnique({ where: { id: ids.tx } });
  assert.equal(tx?.status, 'UNMATCHED');
  assert.equal(tx?.matchedLeaseId, null);
});
