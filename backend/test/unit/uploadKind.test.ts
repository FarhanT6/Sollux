/** Sorting files dropped on Add to the importer that reads them, from their text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindFromText } from '../../src/services/uploadKind';

test('a county property tax bill', () => {
  assert.equal(kindFromText('bill.pdf', 'application/pdf', 'EXAMPLE COUNTY TREASURER-TAX COLLECTOR\nSecured Property Tax Bill 2026-27\nAssessor\'s Parcel Number 123-456-78\nFirst Installment $1,234.00'), 'tax');
});

test('a property manager\'s owner statement', () => {
  assert.equal(kindFromText('oct.pdf', 'application/pdf', 'Owner Statement  October 2026\nBeginning Cash Balance 1,000.00\nRent Income 2,500.00\nManagement Fee (200.00)\nOwner Distribution 3,300.00'), 'manager');
});

test('a utility bill stays a bill, and a spreadsheet is a loan sheet', () => {
  assert.equal(kindFromText('water.pdf', 'application/pdf', 'Example Water District\nAccount Number 123456-654321\nAmount Due $84.20\nDue Date 11/05/2026\nUtility users tax 2.10'), 'bill');
  assert.equal(kindFromText('loans.csv', 'text/csv', 'Lender,Due day,Grace'), 'loan-sheet');
});

test('a photo or a blank text layer is left for a closer look', () => {
  assert.equal(kindFromText('scan.jpg', 'image/jpeg', ''), null);
});
