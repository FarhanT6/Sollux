/** The cost ledger's classification: every cost under one type, from where it came from. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeOfAccount, typeOfExpense, monthsBetween, operatingCharge } from '../../src/lib/costTypes';

test('an account is classified by its category, and insurance by its name too', () => {
  assert.equal(typeOfAccount('ELECTRIC', 'Example Power'), 'UTILITIES');
  assert.equal(typeOfAccount('TRASH', 'Example Waste'), 'UTILITIES');
  assert.equal(typeOfAccount('INSURANCE', 'Example Mutual'), 'INSURANCE');
  // Premium financing bills like a lender but is the insurance premium.
  assert.equal(typeOfAccount('LOAN', 'Example Premium Financing'), 'INSURANCE');
  assert.equal(typeOfAccount('OTHER', 'Example FAIR Plan Association'), 'INSURANCE');
  assert.equal(typeOfAccount('HOA', 'Example HOA'), 'HOA');
  assert.equal(typeOfAccount('LOAN', 'Example Solar Finance'), 'DEBT_SERVICE');
  assert.equal(typeOfAccount('CREDIT_CARD', 'Example Card'), null);
});

test('a logged expense is classified by its category', () => {
  assert.equal(typeOfExpense('REPAIRS_MAINTENANCE', false), 'MAINTENANCE');
  assert.equal(typeOfExpense('HANDYMAN', false), 'MAINTENANCE');
  assert.equal(typeOfExpense('PROPERTY_MANAGEMENT', false), 'MANAGEMENT');
  assert.equal(typeOfExpense('REPAIRS_MAINTENANCE', true), 'CAPITAL');
  assert.equal(typeOfExpense('MORTGAGE_DEBT_SERVICE', false), 'DEBT_SERVICE');
  assert.equal(typeOfExpense('LEGAL', false), 'OTHER');
});

test('months run across a year end', () => {
  assert.deepEqual(monthsBetween('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(monthsBetween('2026-03', '2026-03'), ['2026-03']);
});

test("a bill's operating charge leaves out the true-up deferral and the payment-plan installment", () => {
  assert.equal(operatingCharge({ amountDue: 1257.07, trueUpDeferred: 1005.07, paymentPlanAmount: null }), 252);
  assert.equal(operatingCharge({ amountDue: 300, trueUpDeferred: null, paymentPlanAmount: 120 }), 180);
});
