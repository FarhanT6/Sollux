import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWithdrawalEmail } from '../../src/services/walletEmails';

const at = new Date('2026-11-05T18:00:00Z');

test('Venmo: a standard transfer to a bank, with its last four', () => {
  const w = parseWithdrawalEmail('Venmo <venmo@venmo.com>', 'Your transfer has been initiated', "You've transferred $1,250.00 to your bank. Chase ••1350. It should arrive in 1-3 business days.", at)!;
  assert.deepEqual([w.wallet, w.amount, w.last4, w.bank, w.instant, w.date.toISOString().slice(0, 10)], ['VENMO', 1250, '1350', 'Chase', false, '2026-11-05']);
});

test('Cash App: an instant cash out to a debit card', () => {
  const w = parseWithdrawalEmail('Cash App <cash@square.com>', 'You cashed out $400.00', 'Instant deposit of $400.00 to Wells Fargo debit card ending in 7228. Fee $6.00.', at)!;
  assert.deepEqual([w.wallet, w.amount, w.last4, w.bank, w.instant], ['CASH_APP', 400, '7228', 'Wells Fargo', true]);
});

test("PayPal: you've withdrawn to your bank account", () => {
  const w = parseWithdrawalEmail('service@paypal.com', "You've withdrawn $85.10 USD", "You've withdrawn $85.10 USD from your PayPal balance to your bank account Bank of America x-4821.", at)!;
  assert.deepEqual([w.wallet, w.amount, w.last4, w.bank], ['PAYPAL', 85.1, '4821', 'Bank of America']);
});

test('Apple Cash: transfer to bank', () => {
  const w = parseWithdrawalEmail('Apple <no_reply@email.apple.com>', 'Your Apple Cash transfer', 'Your transfer of $300.00 from Apple Cash to your bank account ending in 0697 has been initiated.', at)!;
  assert.deepEqual([w.wallet, w.amount, w.last4], ['APPLE_CASH', 300, '0697']);
});

test('money in, a failed transfer, and other senders are not withdrawals', () => {
  assert.equal(parseWithdrawalEmail('venmo@venmo.com', 'Sample Tenant paid you $1,400.00', 'Sample Tenant paid you $1,400.00 for rent', at), null);
  assert.equal(parseWithdrawalEmail('venmo@venmo.com', 'Your transfer failed', 'Your transfer of $50.00 to your bank failed.', at), null);
  assert.equal(parseWithdrawalEmail('alerts@bank.example.com', 'Transfer complete', 'You transferred $500.00 to your bank', at), null);
});
