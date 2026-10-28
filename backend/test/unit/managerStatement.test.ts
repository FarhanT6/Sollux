/** Matching a manager's statement lines to the owner's properties, leases and loans. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propertyScore, leaseScore, lenderScore, best, categoryFor } from '../../src/lib/managerStatementMatch';

const props = [
  { id: 'a', address: '1200 Elm Grove Ln', nickname: 'Elm Duplex' },
  { id: 'b', address: '1200 Oak Hollow Rd', nickname: null },
  { id: 'c', address: '45 Harbor View Blvd', nickname: 'De Example' },
];

test('a property is matched by house number and street, or by its nickname', () => {
  assert.equal(best(props, p => propertyScore('1200 Elm Grove Lane, Example City', p))?.id, 'a');
  assert.equal(best(props, p => propertyScore('1200 OAK HOLLOW', p))?.id, 'b');
  assert.equal(best(props, p => propertyScore('De Example', p))?.id, 'c');
  // The house number alone fits two: the owner chooses.
  assert.equal(best(props, p => propertyScore('1200', p)), null);
});

test('a rent line is matched to its tenant, else its unit', () => {
  const leases = [
    { id: 'l1', tenantNames: ['Jordan Example'], unitLabel: 'Unit A' },
    { id: 'l2', tenantNames: ['Priya Sample'], unitLabel: 'Unit B' },
  ];
  assert.equal(best(leases, l => leaseScore('Rent - Jordan Example', l))?.id, 'l1');
  assert.equal(best(leases, l => leaseScore('SAMPLE', l))?.id, 'l2');
  assert.equal(best(leases, l => leaseScore('Unit B rent', l))?.id, 'l2');
  assert.equal(best(leases, l => leaseScore('Rent', l)), null);
});

test('a loan payment is matched to its lender', () => {
  assert.equal(lenderScore('Payment to Example Community Bank', 'Example Community Bank'), 2);
  assert.equal(lenderScore('Gulfstream', 'Riverside Lending'), 0);
});

test('cost lines are filed under their category', () => {
  assert.equal(categoryFor('MANAGEMENT_FEE'), 'PROPERTY_MANAGEMENT');
  assert.equal(categoryFor('REPAIR'), 'REPAIRS_MAINTENANCE');
  assert.equal(categoryFor('RENT'), null);
});
