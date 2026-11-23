/**
 * A loan paid on the servicer's website, logged from its emails: the confirmation logs the month's
 * payment once (a later "processed" email for the same payment is the same one), a payment
 * scheduled ahead is held as pending on the account it comes from, and an unsure one waits for
 * review. Made-up servicer and numbers.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const FROM = 'Example Mortgage Servicing <noreply@examplems.com>';

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } as any });
  ids.user = me.id;
  const prop = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  ids.bank = (await db.bankAccount.create({ data: { userId: me.id, name: 'Example Checking', last4: '1111', accountType: 'CHECKING' } as any })).id;
  ids.loan = (await db.loan.create({ data: { userId: me.id, propertyId: prop.id, lender: 'Example Mortgage Servicing', loanType: 'MORTGAGE', originalAmount: 300000, monthlyPayment: 1234.56, dueDay: 1, accountLast4: '4321', payFromBankAccountId: ids.bank } as any })).id;
});
after(async () => { if (!skip) await api.stop(); });

test('the confirmation logs the month once; the "processed" email after it is the same payment', { skip }, async () => {
  const { parseLenderPaymentEmail, recordLenderPayment } = await import('../../src/services/lenderPaymentEmails');
  const p = parseLenderPaymentEmail(FROM, 'Payment Confirmation', 'Thank you for your payment.\nLoan Number: ******4321\nPayment Amount: $1,234.56\nPayment Date: 11/03/2026\nConfirmation Number: 98765432', new Date('2026-11-03T18:00:00Z'))!;
  const r = await recordLenderPayment(ids.user, p, 'msg-1@example');
  assert.equal(r.outcome, 'loan');
  const pays = await api.db.loanPayment.findMany({ where: { loanId: ids.loan } });
  assert.equal(pays.length, 1);
  assert.equal(pays[0].periodDate?.toISOString().slice(0, 7), '2026-11');
  assert.equal(pays[0].confirmationNumber, '98765432');
  assert.equal(pays[0].method, 'ONLINE');
  // The same email again, and the servicer's second email for the same payment.
  assert.equal((await recordLenderPayment(ids.user, p, 'msg-1@example')).outcome, 'skipped');
  const again = parseLenderPaymentEmail(FROM, 'Your payment has been processed', 'Your payment of $1,234.56 was processed on 11/04/2026. Loan ending in 4321.', new Date('2026-11-04T18:00:00Z'))!;
  await recordLenderPayment(ids.user, again, 'msg-2@example');
  assert.equal(await api.db.loanPayment.count({ where: { loanId: ids.loan } }), 1);
});

test('scheduled ahead: logged on its day and pending on the account it comes from', { skip }, async () => {
  const { parseLenderPaymentEmail, recordLenderPayment } = await import('../../src/services/lenderPaymentEmails');
  const sent = new Date();
  const ahead = new Date(sent.getTime() + 5 * 86_400_000);
  const mdY = `${String(ahead.getUTCMonth() + 1).padStart(2, '0')}/${String(ahead.getUTCDate()).padStart(2, '0')}/${ahead.getUTCFullYear()}`;
  const p = parseLenderPaymentEmail(FROM, 'Payment Scheduled', `Your payment is scheduled.\nLoan Number: ******4321\nPayment Amount: $1,234.56\nScheduled Date: ${mdY}\nConfirmation Number: 55556666`, sent)!;
  assert.equal(p.scheduled, true);
  const r = await recordLenderPayment(ids.user, p, 'msg-3@example');
  assert.equal(r.outcome, 'loan');
  const lp = await api.db.loanPayment.findFirstOrThrow({ where: { loanId: ids.loan, confirmationNumber: '55556666' } });
  assert.equal(await api.db.pendingOutflow.count({ where: { userId: ids.user, sourceRef: `loanpay:${lp.id}`, cleared: false, bankAccountId: ids.bank } }), 1);
});

test('the lender but neither the loan number nor the payment amount: waits for review', { skip }, async () => {
  const { parseLenderPaymentEmail, recordLenderPayment } = await import('../../src/services/lenderPaymentEmails');
  const p = parseLenderPaymentEmail(FROM, 'Payment Confirmation', 'Thank you for your payment.\nPayment Amount: $600.00\nPayment Date: 10/20/2026', new Date('2026-10-20T18:00:00Z'))!;
  const r = await recordLenderPayment(ids.user, p, 'msg-4@example');
  assert.equal(r.outcome, 'review');
  const row = await api.db.outgoingTransaction.findFirstOrThrow({ where: { plaidTransactionId: 'email:msg-4@example' } });
  assert.equal(row.status, 'SUGGESTED');
  assert.equal(row.loanId, ids.loan);
});
