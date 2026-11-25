/**
 * One way to save a bill (services/saveStatement.ts), made-up figures: what each importer used
 * to do differently is now the same — a stale carried figure goes when the bill prints its total,
 * a scheduled installment row becomes the real bill, a paid mark the old reading put there goes,
 * the solar true-up is kept in the bill's data, and an email's file replaces only a stand-in.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const bill = (over: Record<string, unknown> = {}) => ({
  providerName: 'Sample Electric', accountNumber: '123456-654321', serviceAddress: '1200 Elm Grove Ln', utilityType: 'electric',
  statementDate: '2026-10-05', dueDate: '2026-10-25', billingPeriodStart: '2026-09-01', billingPeriodEnd: '2026-09-30',
  amountDue: 120, currentCharges: 120, previousBalance: 0, paymentsReceived: null, statedTotalDue: 120, isPaid: false, lateFee: null,
  chargeBreakdown: { Energy: 120 }, alerts: [], ...over,
}) as any;

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'PRIMARY' } });
  const a = await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample Electric', providerSlug: 'gmail-fallback', category: 'ELECTRIC' } });
  // On file: read before with $40 carried and a "paid" mark the old reading put there, as a scheduled row, from a PDF.
  const s = await db.statement.create({ data: {
    utilityAccountId: a.id, statementDate: d('2026-10-05'), billingPeriodStart: d('2026-09-01'), billingPeriodEnd: d('2026-09-30'),
    amountDue: 100, amountPaid: 100, pastDueCarried: 40, isScheduled: true, pdfS3Key: 'old/statement.pdf', rawDataJson: { source: 'portal' },
  } });
  // A portal's page saved in place of the PDF.
  const page = await db.statement.create({ data: {
    utilityAccountId: a.id, statementDate: d('2026-11-05'), billingPeriodStart: d('2026-10-01'), billingPeriodEnd: d('2026-10-31'),
    amountDue: 90, pdfS3Key: 'old/page.pdf', rawDataJson: { source: 'portal', pageSaved: true },
  } });
  Object.assign(ids, { a: a.id, s: s.id, page: page.id });
});
after(async () => { if (!skip) await api.stop(); });

test('a re-read puts the bill right the same way whatever brought it', { skip }, async () => {
  const { saveStatement, buildRawData } = await import('../../src/services/saveStatement');
  const existing = await api.db.statement.findUniqueOrThrow({ where: { id: ids.s } });
  const ex = bill({ netMetering: { deferred: 20, ytdBalance: 60, trueUpDate: '2027-03-01' } });
  const r = await saveStatement({ accountId: ids.a, ex, statementDate: d('2026-10-05'), existing, rawData: buildRawData(ex, 'email'), pdfS3Key: 'new/email.pdf', pdf: 'upgrade' });
  assert.equal(r.outcome, 'updated');
  const s = await api.db.statement.findUniqueOrThrow({ where: { id: ids.s } });
  assert.equal(Number(s.amountDue), 120);
  assert.equal(s.pastDueCarried, null, 'the bill printed its total: nothing carried');
  assert.equal(s.isScheduled, false, 'the real bill replaces the scheduled row');
  assert.equal(s.amountPaid, null, "the old reading's paid mark goes");
  assert.equal(s.pdfS3Key, 'old/statement.pdf', 'an email does not replace the PDF on file');
  assert.equal(Number(s.trueUpDeferred), 20);
  assert.equal((s.rawDataJson as any).netMetering.deferred, 20, 'the true-up is kept in the bill');
});

test("a portal's PDF replaces the page saved in its place; Add replaces the file it is given", { skip }, async () => {
  const { saveStatement, buildRawData } = await import('../../src/services/saveStatement');
  const page = await api.db.statement.findUniqueOrThrow({ where: { id: ids.page } });
  const ex = bill({ statementDate: '2026-11-05', billingPeriodStart: '2026-10-01', billingPeriodEnd: '2026-10-31', amountDue: 90, currentCharges: 90, statedTotalDue: 90 });
  await saveStatement({ accountId: ids.a, ex, statementDate: d('2026-11-05'), existing: page, rawData: buildRawData(ex, 'portal'), pdfS3Key: 'new/portal.pdf', pdf: 'upgrade' });
  assert.equal((await api.db.statement.findUniqueOrThrow({ where: { id: ids.page } })).pdfS3Key, 'new/portal.pdf');
  const s = await api.db.statement.findUniqueOrThrow({ where: { id: ids.s } });
  const ex2 = bill();
  await saveStatement({ accountId: ids.a, ex: ex2, statementDate: d('2026-10-05'), existing: s, rawData: buildRawData(ex2, 'pdf_import'), pdfS3Key: 'new/upload.pdf', pdf: 'replace', moveDate: true });
  assert.equal((await api.db.statement.findUniqueOrThrow({ where: { id: ids.s } })).pdfS3Key, 'new/upload.pdf');
});

test('a new bill is created with its arrangement, aging and penalty date', { skip }, async () => {
  const { saveStatement, buildRawData } = await import('../../src/services/saveStatement');
  const ex = bill({ statementDate: '2026-12-05', billingPeriodStart: '2026-11-01', billingPeriodEnd: '2026-11-30', amountDue: 150, currentCharges: 150, previousBalance: 75, statedTotalDue: 225,
    paymentPlanAmount: 25, penaltyDate: '2026-12-28', agingBuckets: { current: 150, days30: 75 } });
  const r = await saveStatement({ accountId: ids.a, ex, statementDate: d('2026-12-05'), existing: null, rawData: buildRawData(ex, 'drive_import'), pdfS3Key: 'new/dec.pdf', pdf: 'replace' });
  assert.equal(r.outcome, 'new');
  const s = await api.db.statement.findUniqueOrThrow({ where: { id: r.id } });
  assert.deepEqual([Number(s.amountDue), Number(s.pastDueCarried), Number(s.balance), Number(s.paymentPlanAmount)], [150, 75, 225, 25]);
  assert.equal(s.penaltyDate?.toISOString().slice(0, 10), '2026-12-28');
  assert.deepEqual(s.agingBuckets, { current: 150, days30: 75 });
});
