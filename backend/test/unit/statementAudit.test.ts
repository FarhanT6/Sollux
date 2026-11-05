import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareStatement } from '../../src/services/statementAudit';

const stored = (over: Record<string, unknown> = {}) => ({
  id: 's1', statementDate: new Date('2026-10-05T00:00:00Z'), dueDate: new Date('2026-10-25T00:00:00Z'),
  amountDue: 379.37, pastDueCarried: 741.13, trueUpDeferred: null, rawDataJson: { source: 'pdf_import' }, ...over,
});
const read = (over: Record<string, unknown> = {}) => ({
  currentCharges: 379.37, amountDue: 379.37, previousBalance: 741.13, statedTotalDue: 1120.50,
  dueDate: '2026-10-25', paymentsReceived: 200, paymentPlanAmount: null, ...over,
}) as any;

test('a statement that matches its PDF has no findings', () => {
  assert.deepEqual(compareStatement(stored(), read(), 200), []);
});

test('a penalty read into the charge shows on both the charge and the past due', () => {
  const f = compareStatement(stored({ amountDue: 403.63, pastDueCarried: 716.87 }), read(), 200);
  assert.deepEqual(f.map(x => [x.field, x.stored, x.read, x.fixable]), [
    ['charge', 403.63, 379.37, true],
    ['pastDue', 716.87, 741.13, true],
  ]);
});

test('parts that agree but miss the printed total are flagged without a fix', () => {
  const f = compareStatement(stored(), read({ statedTotalDue: 1130.50 }), 200);
  assert.equal(f.length, 1);
  assert.equal(f[0].field, 'total');
  assert.equal(f[0].fixable, false);
});

test('a due date that differs, and a payment logged twice', () => {
  const f = compareStatement(stored(), read({ dueDate: '2026-10-27' }), 400);
  assert.deepEqual(f.map(x => x.field), ['dueDate', 'payments']);
  assert.match(f[1].note!, /twice/);
});

test('an owner-edited statement is reported but not offered a fix', () => {
  const f = compareStatement(stored({ amountDue: 400, rawDataJson: { ownerEditedAt: '2026-10-10' } }), read(), 200);
  assert.equal(f[0].ownerEdited, true);
  assert.equal(f[0].fixable, false);
});

test('no payments window on the first bill on file: payments are not compared', () => {
  assert.deepEqual(compareStatement(stored(), read({ paymentsReceived: 999 }), null), []);
});
