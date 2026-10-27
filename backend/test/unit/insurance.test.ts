/** Insurance review arithmetic: a premium as a year, a percentage deductible in dollars. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annualPremiumOf, windDollars } from '../../src/services/insuranceReview';

test('a premium is counted as a year', () => {
  assert.equal(annualPremiumOf({ premiumAmount: 150, premiumFrequency: 'MONTHLY' }), 1800);
  assert.equal(annualPremiumOf({ premiumAmount: 900, premiumFrequency: 'SEMI_ANNUAL' }), 1800);
  // A term total wins over the installment; a six-month term is doubled.
  assert.equal(annualPremiumOf({ premiumAmount: 150, premiumFrequency: 'MONTHLY', termPremium: 1700 }), 1700);
  assert.equal(annualPremiumOf({ premiumAmount: 0, premiumFrequency: 'ANNUAL', termPremium: 600, effectiveDate: new Date('2026-01-01'), expirationDate: new Date('2026-07-01') }), 1200);
});

test('a wind/hail deductible as a percentage is spelled out against the dwelling limit', () => {
  assert.equal(windDollars('2% of Coverage A', 400000), 8000);
  assert.equal(windDollars('$2,500', 400000), 2500);
  assert.equal(windDollars('2%', null), null);
  assert.equal(windDollars(null, 400000), null);
});
