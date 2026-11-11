/** "You sent money" emails: the payment the owner made, read without Claude. Made-up names, amounts and numbers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutgoingP2P } from '../../src/services/outgoingP2PEmails';
import { parseP2PEmail } from '../../src/services/p2pPaymentEmails';

const at = new Date('2026-11-11T06:46:00Z');
const bank = 'Example Bank <alerts@notify.example-bank.com>';

test('a bank Zelle "You sent" email: amount, payee, date, account, confirmation and memo', () => {
  const body = 'EXAMPLE BANK | Zelle®\n\nYou sent $1,250.00 to Sam Example\n\nDate: 11/10/2026\n\nFrom account: ...1234\n\nConfirmation: EXCT12AB34CD\n\nMemo: 1200 Elm Grove Ln November 2026 Payment\n\nSee Zelle® Activity\n\nDidn\'t send this money? Please contact us.';
  const p = parseOutgoingP2P(bank, 'You sent money with Zelle®', body, at)!;
  assert.deepEqual({ ...p, date: p.date.toISOString().slice(0, 10) }, {
    channel: 'ZELLE', payee: 'Sam Example', amount: 1250, date: '2026-11-10', confirmation: 'EXCT12AB34CD', fromLast4: '1234', memo: '1200 Elm Grove Ln November 2026 Payment',
  });
  // Not money received.
  assert.equal(parseP2PEmail(bank, 'You sent money with Zelle®', body, at), null);
});

test('the same email as one run of text (an HTML layout)', () => {
  const body = 'EXAMPLE BANK Zelle® You sent $1,250.00 to Sam Example\nDate: 11/10/2026 From account: ...1234 Confirmation: EXCT12AB34CD\nMemo: 1200 Elm Grove Ln November 2026 Payment See Zelle® Activity';
  const p = parseOutgoingP2P(bank, 'You sent money with Zelle®', body, at)!;
  assert.equal(p.payee, 'Sam Example');
  assert.equal(p.fromLast4, '1234');
  assert.equal(p.confirmation, 'EXCT12AB34CD');
  assert.equal(p.memo, '1200 Elm Grove Ln November 2026 Payment');
});

test('Venmo, Cash App and PayPal sends; requests, scheduled and money received are not', () => {
  assert.deepEqual([parseOutgoingP2P('Venmo <venmo@venmo.com>', 'You paid Jordan Sample $50.00', 'You paid Jordan Sample $50.00\nDecember rent share', at)].map(p => p && [p.channel, p.payee, p.amount]), [['VENMO', 'Jordan Sample', 50]]);
  assert.deepEqual([parseOutgoingP2P('Cash App <cash@square.com>', 'You sent $75 to Riley Doe', 'You sent $75.00 to Riley Doe for yard work', at)].map(p => p && [p.channel, p.payee, p.amount]), [['CASH_APP', 'Riley Doe', 75]]);
  assert.deepEqual([parseOutgoingP2P('service@paypal.com', 'You sent a payment', 'You sent $20.00 USD to Pat Sample', at)].map(p => p && [p.channel, p.payee, p.amount]), [['PAYPAL', 'Pat Sample', 20]]);
  assert.equal(parseOutgoingP2P(bank, 'Your Zelle request to Sam Example', 'You requested $50.00 from Sam Example', at), null);
  assert.equal(parseOutgoingP2P(bank, 'Your Zelle payment is scheduled', 'You sent $50.00 to Sam Example on 11/20/2026', at), null);
  assert.equal(parseOutgoingP2P(bank, 'Sam Example sent you money with Zelle', 'SAM EXAMPLE sent you $50.00', at), null);
});
