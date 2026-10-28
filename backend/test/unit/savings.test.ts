/** Where the owner can save: each rule against made-up accounts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSavings, type AccountFacts } from '../../src/lib/savings';

const acct = (o: Partial<AccountFacts>): AccountFacts => ({
  id: 'a', propertyId: 'p1', propertyName: '1200 Elm Grove Ln', providerName: 'Example Power', category: 'ELECTRIC', last4: '1234',
  charges: {}, feesLast12: 0, cardFeesLast12: 0, latePaid: 0, ...o,
});

test('late fees and card fees are what they cost a year', () => {
  const s = findSavings([acct({ feesLast12: 87.5, latePaid: 4, cardFeesLast12: 42 })], [], new Set(['p1']), '2026-10');
  assert.equal(s.find(x => x.kind === 'LATE_FEES')?.perYear, 88);
  assert.equal(s.find(x => x.kind === 'CARD_FEES')?.perYear, 42);
});

test('a bill well up on the same months last year is found; a small rise is not', () => {
  const charges = { '2025-07': 100, '2025-08': 100, '2025-09': 100, '2026-07': 150, '2026-08': 150, '2026-09': 150 };
  const s = findSavings([acct({ charges })], [], new Set(['p1']), '2026-10');
  assert.equal(s[0].kind, 'RISING_BILL');
  assert.equal(s[0].perYear, 600);
  const small = { ...charges, '2026-07': 105, '2026-08': 105, '2026-09': 105 };
  assert.equal(findSavings([acct({ charges: small })], [], new Set(['p1']), '2026-10').length, 0);
});

test('internet at a property with no tenant, and two internet accounts at one property', () => {
  const recent = { '2026-07': 80, '2026-08': 80, '2026-09': 80 };
  const idle = findSavings([acct({ category: 'INTERNET', charges: recent })], [], new Set(), '2026-10');
  assert.equal(idle[0].kind, 'IDLE_SERVICE');
  assert.equal(idle[0].perYear, 960);
  const dup = findSavings([
    acct({ id: 'x', category: 'INTERNET', charges: recent }),
    acct({ id: 'y', category: 'INTERNET', providerName: 'Example Fiber', charges: { '2026-07': 50, '2026-08': 50, '2026-09': 50 } }),
  ], [], new Set(['p1']), '2026-10');
  assert.equal(dup.find(x => x.kind === 'DUPLICATE_SERVICE')?.perYear, 600);
});

test('an insurance premium up on the year before, and a loan at a high rate', () => {
  const charges = { '2025-03': 1500, '2026-03': 1800 };
  const s = findSavings([acct({ category: 'INSURANCE', charges })], [{ id: 'l', lender: 'Example Lending', rate: 9.5, balance: 300000, propertyName: null }], new Set(['p1']), '2026-10');
  assert.equal(s.find(x => x.kind === 'INSURANCE_UP')?.perYear, 300);
  assert.equal(s.find(x => x.kind === 'HIGH_RATE_LOAN')?.perYear, 3000);
});
