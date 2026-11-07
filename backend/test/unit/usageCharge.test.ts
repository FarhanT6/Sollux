import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageChargeOf } from '../../src/services/reimbursement';

test("a tenant's share is of the period's own charges: no plan installment, no late fee", () => {
  assert.equal(usageChargeOf({ amountDue: 400, paymentPlanAmount: 100 }), 300);
  assert.equal(usageChargeOf({ amountDue: 215, penaltiesFees: 15 }), 200);
  assert.equal(usageChargeOf({ amountDue: 415, paymentPlanAmount: 100, penaltiesFees: 15 }), 300);
  assert.equal(usageChargeOf({ amountDue: 120.5 }), 120.5);
});
