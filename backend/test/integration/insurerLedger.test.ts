/**
 * An insurance account lined up with the insurer's records (services/insurerLedger.ts), made-up
 * figures: four installments of $200 with a $20 late fee and a $50 reinstatement fee invoiced
 * among them, and four payments. On file: an invoice whose overdue installment was counted as its
 * own charge, the installment fee read as a "payment agreement", a second copy of one bill, a
 * payment logged twice, and one payment missing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const READ = {
  policyNumber: 'WBP1234567',
  installments: [
    { label: 'Downpayment', date: '2026-01-05', amount: 200 },
    { label: 'Installment 1 of 3', date: '2026-02-03', amount: 200 },
    { label: 'Installment 2 of 3', date: '2026-03-03', amount: 200 },
    { label: 'Installment 3 of 3', date: '2026-04-02', amount: 200 },
  ],
  fees: [{ label: 'Late Fee', date: '2026-02-28', amount: 20 }, { label: 'Reinstatement Fee', date: '2026-03-20', amount: 50 }],
  payments: [
    { date: '2026-01-20', amount: 200, status: 'Completed' },
    { date: '2026-03-21', amount: 270, status: 'Completed' },
    { date: '2026-03-25', amount: 200, status: 'Completed' },
    { date: '2026-04-20', amount: 200, status: 'Pending' },
  ],
};

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'PRIMARY' } });
  const a = await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample Insurer', providerSlug: 'gmail-fallback', category: 'INSURANCE' } });
  const s = (date: string, due: string, amountDue: number, extra: Record<string, unknown> = {}) =>
    db.statement.create({ data: { utilityAccountId: a.id, statementDate: d(date), dueDate: d(due), amountDue, rawDataJson: { source: 'email' }, ...extra } });
  ids.jan = (await s('2026-01-05', '2026-01-25', 200)).id;
  ids.feb = (await s('2026-02-03', '2026-02-23', 215, { paymentPlanAmount: 15 })).id;
  // March's invoice asked for February's installment and fee too, all read as March's own charge.
  ids.mar = (await s('2026-03-03', '2026-03-23', 420)).id;
  ids.dupe = (await s('2026-03-14', '2026-03-23', 200)).id;
  await db.payment.create({ data: { utilityAccountId: a.id, amount: 200, paymentDate: d('2026-01-20'), status: 'PAID', statementId: ids.jan } });
  await db.payment.create({ data: { utilityAccountId: a.id, amount: 270, paymentDate: d('2026-03-21'), status: 'PAID' } });
  await db.payment.create({ data: { utilityAccountId: a.id, amount: 270, paymentDate: d('2026-03-22'), status: 'PAID' } });
  ids.acct = a.id;
  ids.me = me.id;
});
after(async () => { if (!skip) await api.stop(); });

test('the plan: each installment its bill, the copy and the repeat payment flagged, totals as the records say', { skip }, async () => {
  const { planLineUp } = await import('../../src/services/insurerLedger');
  const plan = (await planLineUp(ids.me, ids.acct, READ))!;
  assert.deepEqual(plan.bills.map(b => [b.invoiceDate, b.charge, b.carried, b.total, b.statementId]), [
    ['2026-01-05', 200, 0, 200, ids.jan],
    ['2026-02-03', 220, 0, 220, ids.feb],
    ['2026-03-03', 250, 220, 470, ids.mar],
    ['2026-04-02', 200, 0, 200, null],
  ]);
  assert.deepEqual(plan.removeBills.map(b => b.statementId), [ids.dupe]);
  assert.equal(plan.payments.filter(x => x.paymentId).length, 2);
  assert.equal(plan.removePayments.length, 1, 'the second $270 is not in the records');
  assert.deepEqual([plan.totals.billed, plan.totals.paid, plan.totals.owed], [870, 870, 0]);
});

test('applied: the bills and payments are the records\', and the fee is no "payment agreement"', { skip }, async () => {
  const { applyLineUp } = await import('../../src/services/insurerLedger');
  const r = (await applyLineUp(ids.me, ids.acct, READ, { insurer: 'Sample Insurer' }))!;
  assert.deepEqual([r.updated, r.added, r.removed, r.paymentsAdded, r.paymentsRemoved], [3, 1, 1, 2, 1]);
  const rows = await api.db.statement.findMany({ where: { utilityAccountId: ids.acct }, orderBy: { statementDate: 'asc' } });
  assert.deepEqual(rows.map(s => Number(s.amountDue)), [200, 220, 250, 200]);
  const feb = rows[1]!;
  assert.equal(feb.paymentPlanAmount, null);
  assert.deepEqual((feb.rawDataJson as any).chargeBreakdown, { 'Premium installment': 200, 'Late Fee': 20 });
  assert.equal(Number(rows[2]!.pastDueCarried), 220);
  const pays = await api.db.payment.findMany({ where: { utilityAccountId: ids.acct } });
  assert.equal(pays.reduce((t, p) => t + Number(p.amount), 0), 870);
  assert.ok(pays.every(p => p.statementId == null), 'left to pay the oldest bills first');
});
