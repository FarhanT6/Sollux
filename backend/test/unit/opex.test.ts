/** Operating-expense statement: what is included, typed-in amounts, taxes and insurance, NOI and cash flow. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatement, suggestionsFor, type OpexFacts } from '../../src/lib/opexStatement';

const facts = (over: Partial<OpexFacts> = {}): OpexFacts => ({
  months: 12, rentIncome: 36000, units: 2, sqft: 1800,
  utilities: [
    { id: 'w', name: 'City Water (Water)', category: 'WATER', total: 1200, fees: 50, bills: 12 },
    { id: 't', name: 'Example Waste (Trash)', category: 'TRASH', total: 900, fees: 0, bills: 12 },
  ],
  categories: [{ category: 'REPAIRS_MAINTENANCE', total: 2400, count: 6 }],
  capex: 8000,
  tax: { annual: 4200, source: '2026-27 tax bill' },
  insurance: { annual: null, source: null },
  debt: { paid: 18000, escrow: 3000, monthlyPI: 1250, lenders: ['Example Bank'], fromBills: 0 },
  ...over,
});

test('defaults: every account and category, fees on their own line, taxes from records, insurance missing', () => {
  const s = buildStatement(facts(), {});
  const byKey = Object.fromEntries(s.lines.map(l => [l.key, l.period]));
  assert.equal(byKey['util:w'], 1150);          // the $50 in fees moved out
  assert.equal(byKey['fees'], 50);
  assert.equal(byKey['taxes'], 4200);
  assert.equal(byKey['cat:REPAIRS_MAINTENANCE'], 2400);
  assert.deepEqual(s.missing, ['insurance']);
  assert.equal(s.totals.annual, 1150 + 50 + 900 + 4200 + 2400);
  assert.equal(s.noi.annual, 36000 - 8700);
  assert.equal(s.cashFlow, null);               // no mortgage unless asked
});

test('choices: an account left out, fees excluded, typed-in amounts and an insurance figure', () => {
  const s = buildStatement(facts(), {
    utilities: { t: false }, lateFees: 'exclude', insurance: { source: 'manual', manualAnnual: 1800 },
    manual: [{ id: 'mgmt', label: 'Property management', amount: 8, per: 'pctRent' }, { id: 'pest', label: 'Pest control', amount: 40, per: 'month' }],
  });
  const keys = s.lines.map(l => l.key);
  assert.ok(!keys.includes('util:t') && !keys.includes('fees'));
  assert.equal(s.lines.find(l => l.key === 'manual:mgmt')!.period, 2880);
  assert.equal(s.lines.find(l => l.key === 'manual:pest')!.period, 480);
  assert.equal(s.lines.find(l => l.key === 'insurance')!.period, 1800);
  assert.deepEqual(s.missing, []);
});

test('mortgage below NOI, less the escrow already counted as taxes and insurance', () => {
  const s = buildStatement(facts(), { debtService: true, capex: true });
  assert.equal(s.belowNoi.find(l => l.key === 'debt')!.period, 15000);
  assert.equal(s.cashFlow!.period, s.noi.period - 15000 - 8000);
});

test('a six-month period scales to monthly and annual', () => {
  const s = buildStatement(facts({ months: 6, rentIncome: 18000 }), {});
  assert.equal(s.lines.find(l => l.key === 'taxes')!.period, 2100);
  assert.equal(s.lines.find(l => l.key === 'taxes')!.annual, 4200);
});

test('suggestions leave out what the records cover', () => {
  const ids = suggestionsFor(facts(), {}).map(x => x.id);
  assert.ok(!ids.includes('maintenance'));
  assert.ok(ids.includes('management') && ids.includes('vacancy'));
});
