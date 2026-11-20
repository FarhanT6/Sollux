/** Bank lines that move money to or from a wallet, and app emails about money added. Made-up lines and emails. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletLineOf } from '../../src/lib/walletLines';
import { parseTopUpEmail, parseWithdrawalEmail } from '../../src/services/walletEmails';

const line = (name: string, amount: number, category?: string) => walletLineOf({ name, amount, category });

test('an app paying out to the bank (a credit) is a transfer out of that wallet', () => {
  assert.deepEqual(line('VENMO CASHOUT PPD ID: 0000000000', -700), { kind: 'APP_TO_BANK', wallet: 'VENMO' });
  assert.deepEqual(line('Cash App*Cash Out', -250), { kind: 'APP_TO_BANK', wallet: 'CASH_APP' });
  assert.deepEqual(line('PAYPAL TRANSFER', -80), { kind: 'APP_TO_BANK', wallet: 'PAYPAL' });
  assert.deepEqual(line('APPLE CASH TRANSFER', -1730), { kind: 'APP_TO_BANK', wallet: 'APPLE_CASH' });
});

test('the bank funding an app (a debit) is money added to that wallet', () => {
  assert.deepEqual(line('Cash App*Add Cash', 50), { kind: 'BANK_TO_APP', wallet: 'CASH_APP' });
  assert.deepEqual(line('PAYPAL TRANSFER', 100), { kind: 'BANK_TO_APP', wallet: 'PAYPAL' });
  assert.deepEqual(line('APPLE CASH ADD MONEY', 40), { kind: 'BANK_TO_APP', wallet: 'APPLE_CASH' });
});

test('payments through an app, and app credits that do not say they are a transfer, are not wallet moves', () => {
  assert.equal(line('VENMO PAYMENT 1234567 SAMPLE PERSON', 60), null);   // paid someone, funded from the bank
  assert.equal(line('PAYPAL INST XFER EXAMPLE STORE', 35), null);       // a purchase through PayPal
  assert.equal(line('VENMO 1234 J SAMPLE', -900), null);                 // left to the rent matching
});

test('cash withdrawals go into Cash; cash deposits come out of it; fees and checks are neither', () => {
  assert.deepEqual(line('ATM WITHDRAWAL 1200 ELM GROVE LN', 200), { kind: 'CASH_WITHDRAWAL', wallet: 'CASH' });
  assert.deepEqual(line('NON-BANK ATM CASH WITHDRAWAL', 100), { kind: 'CASH_WITHDRAWAL', wallet: 'CASH' });
  assert.deepEqual(line('WITHDRAWAL MADE IN A BRANCH/STORE', 300, 'TRANSFER_OUT_WITHDRAWAL'), { kind: 'CASH_WITHDRAWAL', wallet: 'CASH' });
  assert.deepEqual(line('CASH DEPOSIT', -500), { kind: 'CASH_DEPOSIT', wallet: 'CASH' });
  assert.deepEqual(line('ATM CASH DEPOSIT', -300), { kind: 'CASH_DEPOSIT', wallet: 'CASH' });
  assert.equal(line('ATM FEE', 3.5), null);
  assert.equal(line('MOBILE DEPOSIT', -1200), null);
  assert.equal(line('DEPOSIT', -861), null);
  assert.equal(line('ONLINE TRANSFER TO SAVINGS', 400), null);
});

const at = new Date('2026-11-14T15:00:00Z');
test('app emails about money added to the balance', () => {
  assert.deepEqual(parseTopUpEmail('Cash App <cash@square.com>', 'You added $50.00 to your Cash balance', 'You added $50.00 from your debit card ending in 1111.', at),
    { wallet: 'CASH_APP', amount: 50, date: new Date('2026-11-14T00:00:00Z'), last4: '1111', bank: null });
  assert.equal(parseTopUpEmail('PayPal <service@paypal.com>', "You've added money", "You've added $120.00 to your PayPal balance from Example Bank account ending 2222.", at)?.amount, 120);
  assert.equal(parseTopUpEmail('Venmo <venmo@venmo.com>', 'Your transfer failed', 'You added $75.00 to Venmo but the transfer failed.', at), null);
  assert.equal(parseTopUpEmail('Venmo <venmo@venmo.com>', 'Sample Person paid you $40.00', 'Sample Person paid you $40.00', at), null);
  assert.equal(parseTopUpEmail('Example Store <news@example.com>', 'You added $20.00 to your cart', '', at), null);
});

test('a transfer-to-bank email is still read as one', () => {
  const w = parseWithdrawalEmail('Venmo <venmo@venmo.com>', 'Your transfer to your bank is on its way', 'You transferred $700.00 to your bank account ending in 2222.', at);
  assert.equal(w?.wallet, 'VENMO');
  assert.equal(w?.amount, 700);
  assert.equal(parseTopUpEmail('Venmo <venmo@venmo.com>', 'Your transfer to your bank is on its way', 'You transferred $700.00 to your bank account ending in 2222.', at), null);
});
