/** Bill lookup fields (lib/lookupFields.ts): made-up numbers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupFieldKind, lookupNumberParts } from '../../src/lib/lookupFields';

test("the FAIR Plan's payment page: the policy number and the mailing ZIP", () => {
  assert.equal(lookupFieldKind('Policy or Quotation Number *'), 'account number');
  assert.equal(lookupFieldKind('Mailing ZIP Code *'), 'ZIP code');
  assert.equal(lookupFieldKind('Account Number'), 'account number');
  assert.equal(lookupFieldKind('Customer Number'), 'customer number');
  assert.equal(lookupFieldKind('Customer or Business Name'), 'name on the bill');
  assert.equal(lookupFieldKind('Username'), null);
});

test('a policy number keeps its space; a two-part account number splits', () => {
  assert.deepEqual(lookupNumberParts('CFP 0123456'), ['CFP 0123456']);
  assert.deepEqual(lookupNumberParts('123456-654321'), ['123456', '654321']);
  assert.deepEqual(lookupNumberParts('123456654321'), ['123456654321']);
});
