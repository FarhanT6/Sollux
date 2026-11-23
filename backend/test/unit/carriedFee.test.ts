/** A late fee hidden in the next bill's previous balance, and the summary box it is read from. Made-up bills. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carriedFeeBetween, type BillFacts } from '../../src/lib/carriedFee';
import { applyPreviousBalanceBoxFromText, applyLedgerFromText, type ExtractedBillData } from '../../src/services/pdfImportService';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const bill = (date: string, f: Partial<BillFacts>): BillFacts => ({ statementDate: d(date), total: null, carried: null, paymentsShown: null, ownFee: 0, unsure: false, ...f });

test('an unpaid bill carried in for more than it asked: the difference is a fee', () => {
  const oct = bill('2026-10-01', { total: 500, carried: 0, paymentsShown: 480 });
  const nov = bill('2026-11-01', { total: 1_070, carried: 550, paymentsShown: 0 });
  assert.deepEqual(carriedFeeBetween(oct, nov), { kind: 'fee', fee: 50, difference: 50 });
});

test('paid late, after the fee went on: still the fee', () => {
  // Paid the $500 it asked; the next bill shows the payment and $50 still carried.
  const r = carriedFeeBetween(bill('2026-10-01', { total: 500 }), bill('2026-11-01', { carried: 50, paymentsShown: 500 }));
  assert.equal(r.kind === 'fee' && r.fee, 50);
});

test('paid on time, or the fee already counted: no fee', () => {
  const oct = bill('2026-10-01', { total: 500 });
  assert.equal(carriedFeeBetween(oct, bill('2026-11-01', { carried: 0, paymentsShown: 500 })).kind, 'none');
  // Listed on the next bill as its own late fee.
  assert.equal(carriedFeeBetween(oct, bill('2026-11-01', { carried: 550, paymentsShown: 0, ownFee: 50 })).kind, 'none');
  // Logged by the owner with a payment against the October bill.
  assert.equal(carriedFeeBetween(oct, bill('2026-11-01', { carried: 550, paymentsShown: 0 }), 50).kind, 'none');
  // Cents of rounding.
  assert.equal(carriedFeeBetween(oct, bill('2026-11-01', { carried: 500.3, paymentsShown: 0 })).kind, 'none');
});

test('not sure enough to say: no fee', () => {
  const oct = bill('2026-10-01', { total: 500 });
  // No payments shown, but one is logged in between: the carried balance cannot be read alone.
  assert.equal(carriedFeeBetween(oct, bill('2026-11-01', { carried: 300 }), 0, 200).kind, 'none');
  // A payment plan or a true-up moves the balance for other reasons.
  assert.equal(carriedFeeBetween(oct, bill('2026-11-01', { carried: 550, paymentsShown: 0, unsure: true })).kind, 'none');
  // A missing month in between, or a re-bill days later.
  assert.equal(carriedFeeBetween(oct, bill('2027-01-01', { carried: 550, paymentsShown: 0 })).kind, 'none');
  assert.equal(carriedFeeBetween(oct, bill('2026-10-05', { carried: 550, paymentsShown: 0 })).kind, 'none');
  // Far too large for a fee: reported, not recorded.
  assert.equal(carriedFeeBetween(oct, bill('2026-11-01', { carried: 900, paymentsShown: 0 })).kind, 'unexplained');
});

test('a "previous balance / payment received / total current charges" box is read, due date from DUE BY', () => {
  const text = [
    'BILLING DATE  11/01/26',
    'PREVIOUS BALANCE  $550.00',
    'PAYMENT RECEIVED  $0.00',
    'TOTAL CURRENT CHARGES  $520.00',
    'DUE BY - 11/15/26',
    'TOTAL AMOUNT DUE  $ 1,070.00',
    'BALANCE FORWARD TURN OFF DAY IS 11/18/26 AT 7 AM *** TURN OFF DAY FOR CURRENT SERVICES IS 12/16/26',
  ].join('\n');
  const ex = { amountDue: 1070, currentCharges: 1070, previousBalance: 0, paymentsReceived: null, statedTotalDue: 1070, dueDate: '2026-12-16' } as unknown as ExtractedBillData;
  applyPreviousBalanceBoxFromText(text, ex);
  assert.equal(ex.previousBalance, 550);
  assert.equal(ex.paymentsReceived, 0);
  assert.equal(ex.amountDue, 520);
  assert.equal(ex.statedTotalDue, 1070);
  assert.equal(ex.dueDate, '2026-11-15');
  // Paid in full the month before: nothing carried.
  const paid = { amountDue: 100 } as unknown as ExtractedBillData;
  applyPreviousBalanceBoxFromText('PREVIOUS BALANCE  $480.00\nPAYMENT RECEIVED  ($480.00)\nTOTAL CURRENT CHARGES  $500.00\nTOTAL AMOUNT DUE  $ 500.00\nDUE BY - 10/15/26', paid);
  assert.equal(paid.previousBalance, null);
  assert.equal(paid.paymentsReceived, 480);
  assert.equal(paid.amountDue, 500);
  // Figures that do not add up to a printed total: left alone.
  const odd = { amountDue: 100 } as unknown as ExtractedBillData;
  applyPreviousBalanceBoxFromText('PREVIOUS BALANCE  $480.00\nPAYMENT RECEIVED  $0.00\nTOTAL CURRENT CHARGES  $500.00\nTOTAL AMOUNT DUE  $ 999.00', odd);
  assert.equal(odd.amountDue, 100);
});

test('an IID bill is read from its own lines (made-up account and figures)', async () => {
  const { applyIidFromText } = await import('../../src/services/pdfImportService');
  const text = [
    'www.iid.com',
    'EXAMPLE  CUSTOMER  Invoice  Date:  06/30/2026',
    'Contract  Account:  12345678  Business  Partner:  1111111  Page:  1  of  1',
    'Meter  Number  Service  Dates  Days  Usage',
    'IID-0000-000000  05/29/2026  06/26/2026  29  35.10',
    'Previous  Balance  $60.00',
    'Payments  Received  by  06/29/2026  ,  Thank  You.  60.00CR',
    'Balance  0.00',
    'Total  Current  Charges  Due  by  07/20/2026  30.00',
    'Account  Balance  $30.00',
  ].join('\n');
  const ex = { providerName: 'IID-0000-000000 05/29/2026', accountNumber: 'Service  Dates  Days  Usage', amountDue: 60, dueDate: '2026-05-29' } as unknown as ExtractedBillData;
  applyIidFromText(text, ex);
  assert.equal(ex.providerName, 'IID');
  assert.equal(ex.accountNumber, '12345678');
  assert.equal(ex.statementDate, '2026-06-30');
  assert.equal(ex.billingPeriodStart, '2026-05-29');
  assert.equal(ex.billingPeriodEnd, '2026-06-26');
  assert.equal(ex.dueDate, '2026-07-20');
  assert.equal(ex.amountDue, 30);
  assert.equal(ex.previousBalance, null);
  assert.equal(ex.paymentsReceived, 60);
  assert.equal(ex.statedTotalDue, 30);
  // Unpaid: the last bill carried in.
  const carried = { amountDue: 1 } as unknown as ExtractedBillData;
  applyIidFromText(text.replace('60.00CR', '0.00').replace('Account  Balance  $30.00', 'Account  Balance  $90.00'), carried);
  assert.equal(carried.previousBalance, 60);
  assert.equal(carried.statedTotalDue, 90);
});

test('a running ledger reprints the payment the bill before showed: it is not a payment since, nor a fee', () => {
  // An HOA ledger: the Aug 19 statement lists Jul 15's and Aug 16's eChecks; the Sep 20 one lists
  // Aug 16's again with Sep 14's. Only Sep 14's came after Aug 19. A fee charged in between is a fee.
  const aug = bill('2026-08-19', { total: 3_000, carried: 2_000, paymentsShown: 2_400, ledger: [{ date: '2026-07-15', amount: 1_200 }, { date: '2026-08-16', amount: 1_200 }] });
  const sep = bill('2026-09-20', { total: 2_800, carried: 1_800, paymentsShown: 2_400, ledger: [{ date: '2026-08-16', amount: 1_200 }, { date: '2026-09-14', amount: 1_200 }] });
  assert.equal(carriedFeeBetween(aug, sep).kind, 'none');
  const withFee = bill('2026-09-20', { total: 2_830, carried: 1_830, paymentsShown: 2_400, ledger: sep.ledger });
  assert.deepEqual(carriedFeeBetween(aug, withFee), { kind: 'fee', fee: 30, difference: 30 });
});

test("a ledger whose text runs words together and prints its header box's values apart is read (made-up account and figures)", () => {
  // As pdf-parse reads a Seabreeze / CINC statement: labels on top, values on a run-together line.
  const text = [
    'Account NumberBilling Date', 'Amount Due', 'DATEDESCRIPTIONCHARGESCREDITSBALANCE', 'Property AddressAs of Date',
    '1200 ELM GROVE LN# 4', 'September20, 2026', '123456654321Oct 1, 2026$2,830.00', 'MAKECHECKPAYABLETO:',
    '08/01/2026BALANCEFORWARD$1,800.00',
    'CURRENTCHARGES',
    '08/01/2026MonthlyAssessment-Unit4 2026$1,000.00$2,800.00',
    '08/11/2026monitoringfee 2026$30.00$2,830.00',
    '08/16/2026eCheck($1,200.00)$1,630.00',
    '09/01/2026MonthlyAssessment-Unit4 2026$1,000.00$2,630.00',
    '09/14/2026eCheck($800.00)$1,830.00',
    '10/01/2026MonthlyAssessment-Unit4 2026$1,000.00$2,830.00',
  ].join('\n');
  const ex = {} as ExtractedBillData;
  applyLedgerFromText(text, ex);
  assert.equal(ex.statementDate, '2026-09-20');
  assert.equal(ex.dueDate, '2026-10-01');
  assert.equal(ex.amountDue, 1_000);
  assert.equal(ex.statedTotalDue, 2_830);
  assert.equal(ex.previousBalance, 1_830);
  assert.deepEqual(ex.ledgerPayments?.map(l => [l.date, l.amount]), [['2026-08-16', 1_200], ['2026-09-14', 800]]);
});
