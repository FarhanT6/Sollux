/** Reading payment emails, and when a payment is logged as rent without asking. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseP2PEmail, sureOfTenant, periodFor, descriptorMemo } from '../../src/services/p2pPaymentEmails';

const at = new Date('2026-10-03T18:00:00Z');

test('Chase and Wells Fargo Zelle emails are read, on separate lines or one', () => {
  const lines = parseP2PEmail('Chase <no.reply.alerts@chase.com>', 'You received money with Zelle®',
    'Zelle® payment\nJANE SAMPLE sent you money\nHere are the details:\nAmount\n$1350.00\nSent on\nOct 03, 2026\nTransaction number\n31000000001\nMemo\nRent Oct', at);
  assert.equal(lines?.payer, 'JANE SAMPLE'); assert.equal(lines?.amount, 1350); assert.equal(lines?.memo, 'Rent Oct');
  const oneLine = parseP2PEmail('Chase <no.reply.alerts@chase.com>', 'You received money with Zelle®',
    'Zelle® payment JANE SAMPLE sent you money Here are the details: Amount $1350.00 Sent on Oct 03, 2026 Transaction number 31000000001 Memo Rent Oct', at);
  assert.equal(oneLine?.memo, 'Rent Oct');
  const business = parseP2PEmail('Wells Fargo <alerts@notify.wellsfargo.com>', 'You received money with Zelle',
    'Wells Fargo home page\nSAMPLE GROUP, LLC sent you $2800.00\nWe deposited the money into your account ending in 1234.', at);
  assert.equal(business?.payer, 'SAMPLE GROUP LLC');
});

test('a payment is logged without asking only when the sender is clearly the tenant', () => {
  const lease = { rentAmount: 1400, arrearsBalance: 300 };
  const whole = { viaAlias: false, exact: true }, partial = { viaAlias: false, exact: false }, alias = { viaAlias: true, exact: true };
  assert.equal(sureOfTenant(whole, lease, 1400, null), true);
  assert.equal(sureOfTenant(alias, lease, 2000, null), true);
  // Most of the name: logged for up to what is owed (rent + arrears), not beyond.
  assert.equal(sureOfTenant(partial, lease, 1700, null), true);
  assert.equal(sureOfTenant(partial, lease, 1800, null), false);
  // Matched by amount alone, an implausible amount, or a memo that is not rent: waits.
  assert.equal(sureOfTenant(null, lease, 1400, null), false);
  assert.equal(sureOfTenant(whole, lease, 5000, null), false);
  assert.equal(sureOfTenant(whole, lease, 120, 'water bill'), false);
});

test('a memo naming the month decides which rent it pays', () => {
  const memo = descriptorMemo('ZELLE FROM JANE SAMPLE ON 09/30 REF # ABC123 OCTOBER RENT 2026');
  assert.equal(memo, 'OCTOBER RENT 2026');
  assert.equal(periodFor(new Date('2026-09-30T00:00:00Z'), memo).toISOString().slice(0, 7), '2026-10');
  assert.equal(periodFor(new Date('2026-10-01T00:00:00Z'), 'OCTOBERS 1ST PART OF THE RENT').toISOString().slice(0, 7), '2026-10');
  // A name is not a month.
  assert.equal(periodFor(new Date('2026-10-01T00:00:00Z'), 'from Jane and Marcus').toISOString().slice(0, 7), '2026-10');
  assert.equal(periodFor(new Date('2026-10-03T00:00:00Z'), '2nd August Rent Payment').toISOString().slice(0, 7), '2026-08');
  assert.equal(periodFor(new Date('2026-10-02T00:00:00Z'), null).toISOString().slice(0, 7), '2026-10');
});
