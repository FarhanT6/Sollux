/** Money math: rent collection fees, how a payment is applied, fees logged with payments, bill reading. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feesFor } from '../../src/services/rentCollection';
import { allocateAccountPayments } from '../../src/lib/paymentAllocation';
import { feesOf, mergeFees, feesTotal } from '../../src/services/lateFees';
import { reconcileWithStatedTotal } from '../../src/services/pdfImportService';

test('card rent is grossed up so the owner receives the full rent', () => {
  const f = feesFor(1850, 'card');
  assert.equal(f.ownerReceives, 1850);
  assert.ok(f.tenantFee > 0);
  // After Stripe's 2.9% + 30¢ the owner is left whole (to the cent).
  assert.ok(Math.abs(f.charge - f.charge * 0.029 - 0.3 - 1850) < 0.01);
});

test('bank (ACH) rent costs the tenant nothing; the owner pays 0.8%, at most $5', () => {
  const small = feesFor(400, 'us_bank_account');
  assert.equal(small.tenantFee, 0);
  assert.equal(small.charge, 400);
  assert.equal(small.stripeFee, 3.2);
  assert.equal(small.ownerReceives, 396.8);
  const big = feesFor(4200, 'us_bank_account');
  assert.equal(big.stripeFee, 5);
  assert.equal(big.ownerReceives, 4195);
});

const d = (s: string) => new Date(`${s}T12:00:00Z`);
const stmt = (id: string, date: string, o: Partial<{ amountDue: number; pastDueCarried: number; penaltiesFees: number; paymentPlanAmount: number }> = {}) =>
  ({ id, statementDate: d(date), billingPeriodEnd: null, amountDue: o.amountDue ?? null, pastDueCarried: o.pastDueCarried ?? null, penaltiesFees: o.penaltiesFees ?? null, paymentPlanAmount: o.paymentPlanAmount ?? null });
const pay = (id: string, date: string, amount: number, o: Partial<{ statementId: string; status: string; feesAddedJson: unknown; lateFeeAdded: number }> = {}) =>
  ({ id, paymentDate: d(date), amount, status: o.status ?? 'PAID', statementId: o.statementId ?? null, feesAddedJson: o.feesAddedJson, lateFeeAdded: o.lateFeeAdded ?? null });

test('a payment pays fees first, then the past-due balance, then this month', () => {
  // A $326.38 bill: $259.78 carried in, $66.60 of fees, the rest current.
  const b = allocateAccountPayments([stmt('aug', '2026-08-05', { amountDue: 326.38, pastDueCarried: 259.78, penaltiesFees: 66.6 })], [pay('p', '2026-08-20', 300, { statementId: 'aug' })]).get('p')!;
  assert.equal(b.toFees, 66.6);
  assert.equal(b.toPastDue, 233.4);
  assert.equal(b.toCurrent, 0);
  assert.ok(b.remainingAfter > 0);
});

test('paying more than a bill asks for leaves the rest as credit', () => {
  const b = allocateAccountPayments([stmt('s', '2026-09-05', { amountDue: 100 })], [pay('p', '2026-09-10', 130, { statementId: 's' })]).get('p')!;
  assert.equal(b.toCurrent, 100);
  assert.equal(b.overpaid, 30);
});

test('a fee paid on its own (no bill) is not counted toward any bill', () => {
  const fees = [{ kind: 'additional', amount: 35 }];
  const b = allocateAccountPayments([stmt('s', '2026-10-05', { amountDue: 200 })], [pay('p', '2026-10-20', 35, { feesAddedJson: fees, lateFeeAdded: 35 })]).get('p')!;
  assert.equal(b.statementId, null);
  assert.equal(b.toFees, 35);
  assert.equal(b.toCurrent, 0);
});

test('a failed payment applies nothing', () => {
  const b = allocateAccountPayments([stmt('s', '2026-10-05', { amountDue: 200 })], [pay('p', '2026-10-20', 200, { statementId: 's', status: 'FAILED' })]).get('p')!;
  assert.equal(b.toCurrent, 0);
  assert.equal(b.overpaid, 0);
});

test('fees logged with a payment: by kind, or an older payment\'s late fee', () => {
  assert.deepEqual(feesOf({ feesAddedJson: [{ kind: 'late', amount: 5 }, { kind: 'contamination', amount: 61.6 }] }), [{ kind: 'late', amount: 5 }, { kind: 'contamination', amount: 61.6 }]);
  assert.deepEqual(feesOf({ lateFeeAdded: 6.07 }), [{ kind: 'late', amount: 6.07 }]);
  assert.deepEqual(feesOf({ feesAddedJson: [{ kind: 'bogus', amount: 9 }] }), []);
  const merged = mergeFees([{ kind: 'late', amount: 5 }, { kind: 'late', amount: 5 }, { kind: 'other', amount: 0 }]);
  assert.deepEqual(merged, [{ kind: 'late', amount: 10 }]);
  assert.equal(feesTotal(merged), 10);
});

test('a "Pending Payment" line is taken out of the charge and the carried balance (SoCalGas Oct 2026)', () => {
  const ex: any = { amountDue: 53.63, currentCharges: 53.63, previousBalance: -18.58, statedTotalDue: 35.05, chargeBreakdown: { 'Gas Commodity': 4, 'Pending Payment': 32.13 } };
  reconcileWithStatedTotal(ex);
  assert.equal(ex.amountDue, 21.5);
  assert.equal(ex.previousBalance, 13.55);
  assert.equal(ex.chargeBreakdown['Pending Payment'], undefined);
  assert.ok(Math.abs(ex.amountDue + ex.previousBalance - ex.statedTotalDue) < 0.01);
});
