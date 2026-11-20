/**
 * A late fee the provider carried into the next bill's previous balance without a line of its own:
 * found, put on the bill paid late (charge, fees, charge list), kept through a re-read of that
 * bill's PDF, and not counted twice when the owner logs it with a payment. Made-up bills.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const LINE = 'Late fee (added to the next bill)';

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } as any });
  ids.user = me.id;
  const prop = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const acct = await db.utilityAccount.create({ data: { propertyId: prop.id, providerName: 'City of Example', providerSlug: 'gmail-fallback', category: 'WATER', billingCadence: 'MONTHLY', accountNumber: '123456' } as any });
  ids.acct = acct.id;
  const st = (date: string, amountDue: number, raw: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    db.statement.create({ data: { utilityAccountId: acct.id, statementDate: d(date), amountDue, rawDataJson: { source: 'pdf_import', ...raw }, ...extra } as any });
  // September paid in time; October's $500 left unpaid; November carries $550 in with nothing received.
  ids.sep = (await st('2026-09-01', 480, { statedTotalDue: 480, currentCharges: 480, previousBalance: null, paymentsReceived: 460 })).id;
  ids.oct = (await st('2026-10-01', 500, { statedTotalDue: 500, currentCharges: 500, previousBalance: null, paymentsReceived: 480, chargeBreakdown: { Water: 200, Sewer: 300 } })).id;
  ids.nov = (await st('2026-11-01', 520, { statedTotalDue: 1070, currentCharges: 520, previousBalance: 550, paymentsReceived: 0 }, { pastDueCarried: 550 })).id;
});
after(async () => { if (!skip) await api.stop(); });

test('the $50 carried in is a late fee on the October bill, once', { skip }, async () => {
  const { settleCarriedFees } = await import('../../src/services/carriedFees');
  const r = await settleCarriedFees(ids.acct);
  assert.equal(r.changed, 1);
  const oct = await api.db.statement.findUniqueOrThrow({ where: { id: ids.oct } });
  assert.equal(Number(oct.amountDue), 550);
  assert.equal(Number(oct.penaltiesFees), 50);
  assert.equal(Number(oct.carriedFee), 50);
  assert.equal((oct.rawDataJson as any).chargeBreakdown[LINE], 50);
  assert.equal((oct.rawDataJson as any).chargeBreakdown.Water, 200);
  // September and November are as they were.
  assert.equal(Number((await api.db.statement.findUniqueOrThrow({ where: { id: ids.sep } })).amountDue), 480);
  assert.equal(Number((await api.db.statement.findUniqueOrThrow({ where: { id: ids.nov } })).amountDue), 520);
  // Again: nothing changes.
  assert.equal((await settleCarriedFees(ids.acct)).changed, 0);
});

test('a re-read of the October PDF keeps it', { skip }, async () => {
  const { restoreLateFees } = await import('../../src/services/lateFees');
  const { settleCarriedFees } = await import('../../src/services/carriedFees');
  // What a re-read writes: the PDF's charge and a fresh charge list (fees left as they were).
  await api.db.statement.update({ where: { id: ids.oct }, data: { amountDue: 500, rawDataJson: { source: 'pdf_import', statedTotalDue: 500, currentCharges: 500, previousBalance: null, paymentsReceived: 480, chargeBreakdown: { Water: 200, Sewer: 300 } } } });
  await restoreLateFees(ids.oct);
  const oct = await api.db.statement.findUniqueOrThrow({ where: { id: ids.oct } });
  assert.equal(Number(oct.amountDue), 550);
  assert.equal(Number(oct.penaltiesFees), 50);
  assert.equal((oct.rawDataJson as any).chargeBreakdown[LINE], 50);
  assert.equal((await settleCarriedFees(ids.acct)).changed, 0);
});

test('the report lists it; logged by the owner with a payment, it is not counted twice', { skip }, async () => {
  const res = await fetch(`${api.url}/api/statements/carried-fees`);
  assert.equal(res.status, 200);
  const report = await res.json() as { rows: { statementId: string; fee: number; billTotal: number; nextCarried: number }[]; total: number };
  assert.equal(report.total, 50);
  assert.deepEqual(report.rows.map(r => [r.statementId, r.fee, r.billTotal, r.nextCarried]), [[ids.oct, 50, 500, 550]]);

  const { applyFees } = await import('../../src/services/lateFees');
  await api.db.payment.create({ data: { utilityAccountId: ids.acct, statementId: ids.oct, amount: 550, lateFeeAdded: 50, feesAddedJson: [{ kind: 'late', amount: 50 }], paymentDate: d('2026-11-10') } as any });
  await applyFees(ids.oct, [{ kind: 'late', amount: 50 }]);
  const oct = await api.db.statement.findUniqueOrThrow({ where: { id: ids.oct } });
  assert.equal(Number(oct.amountDue), 550);
  assert.equal(Number(oct.penaltiesFees), 50);
  assert.equal(oct.carriedFee, null);
  const lines = (oct.rawDataJson as any).chargeBreakdown;
  assert.equal(lines[LINE], undefined);
  assert.equal(lines['Late fee (paid late)'], 50);
});
