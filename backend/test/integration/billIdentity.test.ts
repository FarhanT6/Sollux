/**
 * Bills whose figures do not add up to the total they printed (#278, made-up accounts and figures):
 * the bill before says which figure was misread.
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
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const mk = (name: string) => db.utilityAccount.create({ data: { propertyId: p.id, providerName: name, providerSlug: 'gmail-fallback', category: 'WATER' } });
  const st = (acct: string, date: string, amountDue: number, carried: number | null, stated: number) =>
    db.statement.create({ data: { utilityAccountId: acct, statementDate: d(date), amountDue, pastDueCarried: carried, rawDataJson: { source: 'pdf_import', statedTotalDue: stated } } });
  // A: carried over-read. Sep asked $800; $50 paid since; Oct carried $750 + $400 charge = $1,150 printed, read as $780 carried.
  const a = await mk('Sample Water A');
  await st(a.id, '2026-09-06', 400, 400, 800);
  await db.payment.create({ data: { utilityAccountId: a.id, amount: 50, paymentDate: d('2026-09-20'), status: 'PAID' } });
  ids.aOct = (await st(a.id, '2026-10-06', 400, 780, 1_150)).id;
  // B: charge misread. Sep asked $300, paid in full; Oct carried $0... but read: carried 120 (right: Sep 420 − 300 paid), charge 500 vs printed 520.
  const b = await mk('Sample Water B');
  await st(b.id, '2026-09-06', 420, null, 420);
  await db.payment.create({ data: { utilityAccountId: b.id, amount: 300, paymentDate: d('2026-09-20'), status: 'PAID' } });
  ids.bOct = (await st(b.id, '2026-10-06', 500, 120, 520)).id;
  // C: carried counted twice. Sep paid in full; Oct's charge is its whole $283 total, read with $1,385 carried.
  const c = await mk('Sample Insurer C');
  await st(c.id, '2026-09-01', 283, null, 283);
  await db.payment.create({ data: { utilityAccountId: c.id, amount: 283, paymentDate: d('2026-09-10'), status: 'PAID' } });
  ids.cOct = (await st(c.id, '2026-10-01', 283, 1_385, 283)).id;
});
after(async () => { if (!skip) await api.stop(); });

test('the bill before says which figure was misread', { skip }, async () => {
  const { reconcileStatement } = await import('../../src/services/billIdentity');
  assert.equal(await reconcileStatement(ids.aOct), 'carried');
  const a = await api.db.statement.findUniqueOrThrow({ where: { id: ids.aOct } });
  assert.equal(Number(a.pastDueCarried), 750);
  assert.equal(await reconcileStatement(ids.bOct), 'charge');
  const b = await api.db.statement.findUniqueOrThrow({ where: { id: ids.bOct } });
  assert.equal(Number(b.amountDue), 400);
  assert.equal(await reconcileStatement(ids.cOct), 'double-carried');
  const c = await api.db.statement.findUniqueOrThrow({ where: { id: ids.cOct } });
  assert.equal(c.pastDueCarried, null);
  // Once right, nothing more.
  assert.equal(await reconcileStatement(ids.aOct), 'ok');
});
