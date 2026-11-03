import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateAccountPayments } from '../../src/lib/paymentAllocation';

const stmt = (id: string, date: string, due: number, carried: number) =>
  ({ id, statementDate: new Date(`${date}T00:00:00Z`), billingPeriodEnd: null, amountDue: due, pastDueCarried: carried, penaltiesFees: 0, paymentPlanAmount: 0 });
const pay = (id: string, date: string, amount: number, statementId: string) =>
  ({ id, paymentDate: new Date(`${date}T00:00:00Z`), amount, status: 'PAID', statementId });

test('a bill whose printed past due was already paid: the payment is its own charge', () => {
  const statements = [stmt('sep', '2026-09-20', 164.02, 0), stmt('oct', '2026-10-20', 180.67, 164.02)];
  const payments = [pay('p-sep', '2026-10-19', 164.02, 'sep'), pay('p-oct', '2026-11-02', 164.02, 'oct')];
  const b = allocateAccountPayments(statements, payments).get('p-oct')!;
  assert.equal(b.toPastDue, 0);
  assert.equal(b.toCurrent, 164.02);
  assert.equal(b.remainingAfter, 16.65);
});

test('a past due still unpaid is paid first', () => {
  const statements = [stmt('sep', '2026-09-20', 164.02, 0), stmt('oct', '2026-10-20', 180.67, 164.02)];
  const b = allocateAccountPayments(statements, [pay('p-oct', '2026-11-02', 164.02, 'oct')]).get('p-oct')!;
  assert.equal(b.toPastDue, 164.02);
});
