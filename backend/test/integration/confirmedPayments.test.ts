/**
 * A bill's printed "payments received" against money the owner already logged: split across two
 * bills it is the same money, not a second payment (it read as a credit and paid the next bill).
 * Made-up account and amounts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00Z`);

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } as any });
  const prop = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const acct = await db.utilityAccount.create({ data: { propertyId: prop.id, providerName: 'Example Electric', providerSlug: 'gmail-fallback', category: 'ELECTRIC', billingCadence: 'MONTHLY', accountNumber: '12345678' } as any });
  ids.acct = acct.id;
  const st = (date: string, amountDue: number, carried: number | null) => db.statement.create({ data: { utilityAccountId: acct.id, statementDate: d(date), amountDue, pastDueCarried: carried, rawDataJson: { source: 'pdf_import' } } as any });
  ids.aug = (await st('2026-08-31', 40, null)).id;
  ids.sep = (await st('2026-09-30', 30, 40)).id;
  ids.oct = (await st('2026-10-29', 35, null)).id;
  // One $70 card payment on Oct 22, logged as $30 toward September and $40 toward August.
  await db.payment.createMany({ data: [
    { utilityAccountId: acct.id, statementId: ids.sep, amount: 30, paymentDate: d('2026-10-22'), status: 'PAID', splitGroupId: 'g1' },
    { utilityAccountId: acct.id, statementId: ids.aug, amount: 40, paymentDate: d('2026-10-22'), status: 'PAID', splitGroupId: 'g1' },
  ] as any });
});
after(async () => { if (!skip) await api.stop(); });

const confirmations = () => api.db.payment.findMany({ where: { utilityAccountId: ids.acct, notes: { contains: '[from-statement:' } } });

test('the October bill printing "$70 received" records nothing new', { skip }, async () => {
  const { recordConfirmedPayment } = await import('../../src/services/pdfImportService');
  await recordConfirmedPayment(ids.acct, ids.oct, { statementDate: '2026-10-29', paymentsReceived: 70 } as any);
  assert.equal((await confirmations()).length, 0);
});

test('only what was not logged is recorded', { skip }, async () => {
  const { recordConfirmedPayment } = await import('../../src/services/pdfImportService');
  // The bill says $95 came in: $25 more than was logged.
  await recordConfirmedPayment(ids.acct, ids.oct, { statementDate: '2026-10-29', paymentsReceived: 95 } as any);
  const c = await confirmations();
  assert.equal(c.length, 1);
  assert.equal(Number(c[0].amount), 25);
  // Read again saying $70: the confirmation goes.
  await recordConfirmedPayment(ids.acct, ids.oct, { statementDate: '2026-10-29', paymentsReceived: 70 } as any);
  assert.equal((await confirmations()).length, 0);
});

test('repeats recorded before this are taken off once', { skip }, async () => {
  const { dedupeConfirmedPayments } = await import('../../src/services/pdfImportService');
  await api.db.statement.update({ where: { id: ids.oct }, data: { rawDataJson: { source: 'pdf_import', paymentsReceived: 70 } } });
  await api.db.payment.create({ data: { utilityAccountId: ids.acct, statementId: ids.sep, amount: 70, paymentDate: d('2026-10-28'), status: 'PAID', notes: `Confirmed by the 2026-10-29 statement ("Payments Received"). [from-statement:${ids.oct}]` } as any });
  const r = await dedupeConfirmedPayments();
  assert.equal(r.removed, 1);
  assert.equal((await confirmations()).length, 0);
  // The owner's own two payments stay.
  assert.equal(await api.db.payment.count({ where: { utilityAccountId: ids.acct } }), 2);
});
