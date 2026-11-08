import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCardStatementText } from '../../src/lib/cardStatementText';

// Made-up statements in the layouts issuers print (layoutText output: one printed line per line).
const LEGAL = '\nInformation About Your Account. Pay at least the minimum payment by the due date to avoid a late fee.\n'.repeat(3);

const bankCard = `New Balance
$1,234.56
Minimum Payment Due
$45.00
Payment Due Date  Rewards summary
02/25/26  +1 Point per $1 earned on all other purchases  120
ACCOUNT SUMMARY
Account Number:  XXXX XXXX XXXX 1234
Previous Balance  $1,000.00
Payment, Credits  -$300.00
Purchases  +$520.00
Cash Advances  $0.00
Balance Transfers  $0.00
Fees Charged  $0.00
Interest Charged  +$14.56
New Balance  $1,234.56
Opening/Closing Date  12/31/25 - 01/30/26
Credit Limit  $5,000
Available Credit  $3,765
Payment Due Date:  02/25/26
Minimum Payment Due:  $45.00
www.chase.com
ACCOUNT ACTIVITY
PAYMENTS AND OTHER CREDITS
01/10  Payment Thank You-Mobile  -300.00
PURCHASE
12/31  GROCERY MART 123 ANYTOWN  20.00
01/15  HARDWARE STORE 456 ANYTOWN  500.00
INTEREST CHARGED
01/30  PURCHASE INTEREST CHARGE  14.56
Purchases  21.99%  (v)  (d)  $1,100.00  $14.56
Cash Advances  27.99%  (v)  (d)  - 0 -  - 0 -
31 Days in Billing Period
Only the minimum  10 years  $3,456
${LEGAL}`;

const storeCard = `Account  number  ending   in   5678
Summary  of  Account  Activity  Payment  Information
Previous  Balance  $25.00  CR  New    Balance  $25.00  CR
Payments  -$0.00  Minimum  Payment  Due  $0.00
Other  Credits  -$0.00  Payment  Due   Date  June  8,  2025
Purchases/Other  Debits  +$0.00
Fees  Charged  +$0.00
Interest  Charged  +$0.00
Credit  Limit  $1,500.00
Statement  Closing   Date  05/12/2025
Next  Statement  Closing   Date  06/11/2025
Days   in   Billing   Cycle  31
This  Account  is    Issued  by  Citibank,  N.A.
Revolving  Balance  29.99%  (M)  $0.00  $0.00
${LEGAL}`;

const appleStyle = `Payment Due: $50.00
Statement
Apple Card Customer  Mar 1  —  Mar 31, 2026
Your March Balance  Minimum  Payment
as of Mar 31, 2026  Payment Due  Due By
$900.00  $50.00  Apr 30, 2026
Previous Monthly Balance  $800.00
Previous Total Balance  $800.00
Total Balance  $900.00
Only minimum payment  5 years  $1,500
Payments
03/05/2026  Apple Cash payment  -$200.00
Total payments for this period  -$200.00
Transactions
03/10/2026  COFFEE SHOP 1 MAIN ST ANYTOWN  2%  $6.00  $300.00
03/20/2026  RETURN COFFEE SHOP  -$10.00
Total Daily Cash this month  $6.00
Total charges, credits and returns  $290.00
Interest charge  $10.00
Total interest for this month  $10.00
Annual Percentage Rate (APR)  19.99 %  (variable)
Apple Card is issued by Goldman Sachs Bank USA, Salt Lake City Branch.
${LEGAL}`;

test('a bank card statement: summary, dates, terms and every transaction', () => {
  const r = readCardStatementText(bankCard)!;
  assert.ok(r);
  assert.equal(r.issuer, 'Chase');
  assert.equal(r.last4, '1234');
  assert.equal(r.periodStart, '2025-12-31');
  assert.equal(r.closingDate, '2026-01-30');
  assert.equal(r.dueDate, '2026-02-25');
  assert.deepEqual([r.previousBalance, r.paymentsCredits, r.purchases, r.interestCharged, r.newBalance, r.minimumPayment], [1000, 300, 520, 14.56, 1234.56, 45]);
  assert.deepEqual([r.creditLimit, r.availableCredit, r.purchaseApr, r.cashAdvanceApr, r.daysInCycle], [5000, 3765, 21.99, 27.99, 31]);
  assert.deepEqual([r.minPayoffMonths, r.minPayoffTotal], [120, 3456]);
  // A December charge on a January statement is the year before.
  assert.deepEqual(r.transactions.map(t => [t.date, t.kind, t.amount]), [
    ['2026-01-10', 'PAYMENT', -300],
    ['2025-12-31', 'PURCHASE', 20],
    ['2026-01-15', 'PURCHASE', 500],
    ['2026-01-30', 'INTEREST', 14.56],
  ]);
});

test('a store card in credit: CR is negative, the next closing date is not this one', () => {
  const r = readCardStatementText(storeCard)!;
  assert.ok(r);
  assert.equal(r.issuer, 'Citi');
  assert.equal(r.last4, '5678');
  assert.equal(r.previousBalance, -25);
  assert.equal(r.newBalance, -25);
  assert.equal(r.minimumPayment, 0);
  assert.equal(r.closingDate, '2025-05-12');
  assert.equal(r.periodStart, '2025-04-12');
  assert.equal(r.dueDate, '2025-06-08');
  assert.equal(r.creditLimit, 1500);
  assert.equal(r.purchaseApr, 29.99);
});

test('Apple Card layout: the balance box, the period, and interest added as a line', () => {
  const r = readCardStatementText(appleStyle)!;
  assert.ok(r);
  assert.equal(r.cardName, 'Apple Card');
  assert.equal(r.last4, null);
  assert.deepEqual([r.periodStart, r.closingDate, r.dueDate], ['2026-03-01', '2026-03-31', '2026-04-30']);
  // "Previous Total Balance" is not the new balance.
  assert.deepEqual([r.previousBalance, r.paymentsCredits, r.purchases, r.interestCharged, r.newBalance, r.minimumPayment], [800, 200, 290, 10, 900, 50]);
  assert.equal(r.purchaseApr, 19.99);
  assert.equal(r.rewardsEarned, 6);
  assert.deepEqual(r.transactions.map(t => [t.kind, t.amount, t.description]), [
    ['PAYMENT', -200, 'Apple Cash payment'],
    ['PURCHASE', 300, 'COFFEE SHOP 1 MAIN ST ANYTOWN'],
    ['CREDIT', -10, 'RETURN COFFEE SHOP'],
    ['INTEREST', 10, 'Interest charge'],
  ]);
});

test('a summary that does not add up is left to Claude', () => {
  assert.equal(readCardStatementText(bankCard.replace('Interest Charged  +$14.56', 'Interest Charged  +$41.56')), null);
});

test('transactions that miss rows are dropped; the summary is kept', () => {
  const r = readCardStatementText(bankCard.replace('01/15  HARDWARE STORE 456 ANYTOWN  500.00\n', ''))!;
  assert.ok(r);
  assert.equal(r.newBalance, 1234.56);
  assert.deepEqual(r.transactions, []);
});

test('a utility bill is not a card statement', () => {
  const bill = `City Water Department\nAccount Number 123456-654321\nPrevious Balance $80.00\nPayments -$80.00\nCurrent Charges $75.00\nTotal Amount Due $75.00\nDue Date 10/25/2026\n${LEGAL}`;
  assert.equal(readCardStatementText(bill), null);
});

// A store card with a Reference # column, credits marked by a trailing minus, and a returned payment.
const storeCardActivity = `Account number ending in 4321
Summary of Account Activity  Payment Information
Previous Balance  $100.00  New Balance  $1,180.00
Payments  +$950.00  Minimum Payment Due  $29.00
Other Credits  -  $20.00  Payment Due Date  August 8, 2026
Purchases/Other Debits  +$100.00
Fees Charged  +$50.00
Interest Charged  +$0.00
Past Due Amount  $0.00
Credit Limit  $3,000.00
Statement Closing Date  07/12/2026
Days in Billing Cycle  31
Only the minimum payment  8 months  $1,200
You must pay your promotional balance of  $100.00  in full by  12/08/27  to avoid paying deferred interest charges.
This Account is Issued by Citibank, N.A.
TRANSACTIONS
Trans Date  Description  Reference #  Amount
06/12  REFUND RETURN CK CHG  F123456AB000XYZ  $  20.00  -
06/12  PAYMENT REVERSAL  F123456AB000XYA  $  1,000.00
06/15  PAY-BY-PHONE PAYMENT     ANYTOWN    IL  P123456AB000XYB  $  50.00  -
06/20  THE HOME DEPOT ANYTOWN  CA  0123456  $  100.00
PLUMBING
FEES
06/12  RETURNED CHECK CHG  $  50.00
TOTAL FEES FOR THIS PERIOD  $  50.00
Total Fees Charged in 2026  $50.00
${LEGAL}`;

test('a returned payment, trailing-minus credits, references, departments and promotions', () => {
  const r = readCardStatementText(storeCardActivity)!;
  assert.ok(r);
  // Payments net of the reversal put the balance up: 100 + 950 − 20 + 100 + 50 = 1,180.
  assert.equal(r.paymentsCredits, -930);
  assert.equal(r.pastDueAmount, 0);
  assert.equal(r.feesYtd, 50);
  assert.deepEqual([r.minPayoffMonths, r.minPayoffTotal], [8, 1200]);
  assert.deepEqual(r.promotions.map(p => [p.balance, p.payBy]), [[100, '2027-12-08']]);
  assert.equal(r.introAprEndDate, '2027-12-08');
  assert.deepEqual(r.transactions.map(t => [t.kind, t.amount, t.reference, t.description]), [
    ['CREDIT', -20, 'F123456AB000XYZ', 'REFUND RETURN CK CHG'],
    ['PAYMENT', 1000, 'F123456AB000XYA', 'PAYMENT REVERSAL'],
    ['PAYMENT', -50, 'P123456AB000XYB', 'PAY-BY-PHONE PAYMENT ANYTOWN IL'],
    ['PURCHASE', 100, '0123456', 'THE HOME DEPOT ANYTOWN CA · PLUMBING'],
    ['FEE', 50, null, 'RETURNED CHECK CHG'],
  ]);
  assert.equal(r.transactions[3].category, 'Home improvement');
});
