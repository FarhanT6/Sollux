import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStudentLoanFromText } from '../../src/services/pdfImportService';

// Made-up figures in a federal student-loan statement's layout, as pdf-parse runs labels into amounts.
const text = `Current Balance$2,000.00
Regular Monthly Payment Amount$40.00
Amount Already Paid for This Month-$10.00
Past Due Amount (if applicable)+ $20.00
Current Amount Due
Current Statement Due Date11/9/2026
Current Amount Due$50.00`;

test('a student-loan statement: the month less what was already paid, the past due carried, the printed total', () => {
  const ex: any = { amountDue: 60, previousBalance: null };
  applyStudentLoanFromText(text, ex);
  assert.equal(ex.amountDue, 30);
  assert.equal(ex.previousBalance, 20);
  assert.equal(ex.statedTotalDue, 50);
  assert.equal(ex.totalAccountBalance, 2000);
  assert.equal(ex.dueDate, '2026-11-09');
});

test('figures that do not add up are left alone', () => {
  const ex: any = { amountDue: 60 };
  applyStudentLoanFromText(text.replace('$50.00', '$55.00'), ex);
  assert.equal(ex.amountDue, 60);
});

test('the last payment, reprinted on every statement, is a dated payment, not "payments received"', () => {
  const ex: any = { amountDue: 60, paymentsReceived: 75 };
  applyStudentLoanFromText(`Last Payment (Effective 10/2/2026)$75.00\n${text}`, ex);
  assert.equal(ex.paymentsReceived, null);
  assert.deepEqual(ex.ledgerPayments, [{ date: '2026-10-02', amount: 75, description: 'Last payment (effective 10/2/2026)' }]);
});

test('no last payment printed: nothing received', () => {
  const ex: any = { amountDue: 60, paymentsReceived: 40 };
  applyStudentLoanFromText(text, ex);
  assert.equal(ex.paymentsReceived, 0);
});
