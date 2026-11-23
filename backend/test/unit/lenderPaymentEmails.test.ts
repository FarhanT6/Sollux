/** A loan paid on the servicer's website, read from its payment email. Made-up senders and numbers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLenderPaymentEmail, sureLender, type LenderMatch } from '../../src/services/lenderPaymentEmails';

const at = (s: string) => new Date(s);

test('a servicer\'s payment confirmation: amount, date, confirmation, loan number', () => {
  const p = parseLenderPaymentEmail('Example Mortgage Servicing <noreply@examplems.com>', 'Payment Confirmation',
    'Thank you for your payment.\nLoan Number: ******4321\nPayment Amount: $1,234.56\nPayment Date: 11/03/2026\nConfirmation Number: 98765432\nPaid from: Checking ending in 1111', at('2026-11-03T18:00:00Z'))!;
  assert.equal(p.amount, 1234.56);
  assert.equal(p.date.toISOString().slice(0, 10), '2026-11-03');
  assert.equal(p.confirmation, '98765432');
  assert.equal(p.loanLast4, '4321');
  assert.equal(p.fromLast4, '1111');
  assert.equal(p.scheduled, false);
  assert.equal(p.sender, 'Example Mortgage Servicing');
});

test('"Thanks for your payment … posted to your account on" and a scheduled one with its post date', () => {
  const posted = parseLenderPaymentEmail('Example Lender <alerts@example-lender.com>', "We've received your payment",
    'Account ending in  2222\nThanks for your payment\nYour Payment of $135.00 posted to your account on October 01, 2026.', at('2026-10-02T11:48:00Z'))!;
  assert.equal(posted.amount, 135);
  assert.equal(posted.date.toISOString().slice(0, 10), '2026-10-01');
  assert.equal(posted.loanLast4, '2222');

  const sched = parseLenderPaymentEmail('Example Lender <alerts@example-lender.com>', 'Your Scheduled Payment',
    'Account ending in  2222\nSAMPLE NAME, your online payment is scheduled\nAmount: $135.00\nPayment Post Date: October 01, 2026\nConfirmation Number: AB12-CD34-EF56\nBank Account Name: Example Bank NA account ending in 1111\nfor account number ending with 2222.', at('2026-10-01T06:27:00Z'))!;
  assert.equal(sched.date.toISOString().slice(0, 10), '2026-10-01');
  assert.equal(sched.scheduled, true);
  assert.equal(sched.confirmation, 'AB12-CD34-EF56');
  assert.equal(sched.fromLast4, '1111');
  assert.equal(sched.loanLast4, '2222');
});

test('reminders, failures and Zelle are not payments made here', () => {
  assert.equal(parseLenderPaymentEmail('Example <a@example.com>', 'Your payment is due Nov 1', 'Payment Amount: $500.00', at('2026-10-25T00:00:00Z')), null);
  assert.equal(parseLenderPaymentEmail('Example <a@example.com>', 'Payment failed', 'Thank you for your payment of $500.00', at('2026-10-25T00:00:00Z')), null);
  assert.equal(parseLenderPaymentEmail('Example Bank <a@example.com>', 'You sent $500.00 with Zelle', 'Thank you for your payment of $500.00', at('2026-10-25T00:00:00Z')), null);
});

test('sure: the loan number and the lender both, or one loan at exactly its payment', () => {
  const m = (o: Partial<LenderMatch>): LenderMatch => ({ loanId: 'x', lender: 'L', expected: 1000, diff: 0, nameHit: true, last4Hit: false, payFromBankAccountId: null, dueDay: 1, ...o });
  assert.equal(sureLender([m({ loanId: 'a', diff: 25, last4Hit: true })])?.loanId, 'a');
  assert.equal(sureLender([m({ loanId: 'a', diff: 0 }), m({ loanId: 'b', diff: 0.5 })]), null);
  assert.equal(sureLender([m({ loanId: 'a', diff: 0 }), m({ loanId: 'b', diff: 40 })])?.loanId, 'a');
  assert.equal(sureLender([m({ loanId: 'a', diff: 40 })]), null);
});
