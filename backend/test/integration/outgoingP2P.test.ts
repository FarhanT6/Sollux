/**
 * A "you sent money" email is a loan payment when it surely is one: by the lender's name, the memo's
 * address picking between a lender's loans or finding the loan when the name is not on file, the memo's
 * month; once only; a near miss waits in Expense Payments. Made-up names and amounts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  ids.user = me.id;
  const p = (address: string) => db.property.create({ data: { userId: me.id, address, city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const elm = await p('1200 Elm Grove Ln'), oak = await p('88 Oak Hollow Rd'), pine = await p('12 Pine Ct');
  const loan = (lender: string, propertyId: string, monthlyPayment: number) => db.loan.create({ data: { userId: me.id, propertyId, lender, loanType: 'MORTGAGE', isActive: true, monthlyPayment, dueDay: 1 } as any });
  ids.elm = (await loan('Sam Example', elm.id, 1250)).id;
  ids.oak = (await loan('Sam Example', oak.id, 1250)).id;   // the same lender, two loans of one payment
  ids.pine = (await loan('Private Note Holder', pine.id, 900)).id;
  ids.bank = (await db.bankAccount.create({ data: { userId: me.id, name: 'Checking', bank: 'Example Bank', last4: '1234', accountType: 'CHECKING' } as any })).id;
});
after(async () => { if (!skip) await api.stop(); });

const sent = (payee: string, amount: number, memo: string | null, date = '2026-11-10') =>
  ({ channel: 'ZELLE' as const, payee, amount, date: new Date(`${date}T00:00:00Z`), confirmation: 'EXCT12AB34CD', fromLast4: '1234', memo });

test('the memo\'s address picks the lender\'s loan; logged for the memo\'s month, once', { skip }, async () => {
  const { recordOutgoingP2P } = await import('../../src/services/outgoingP2PEmails');
  const r = await recordOutgoingP2P(ids.user, sent('Sam Example', 1250, '1200 Elm Grove Ln November 2026 Payment'), 'msg-1');
  assert.equal(r.outcome, 'loan');
  const pays = await api.db.loanPayment.findMany({ where: { loanId: { in: [ids.elm, ids.oak] } } });
  assert.equal(pays.length, 1);
  assert.equal(pays[0].loanId, ids.elm);
  assert.equal(pays[0].periodDate!.toISOString().slice(0, 7), '2026-11');
  assert.equal(pays[0].method, 'ZELLE');
  assert.match(pays[0].notes ?? '', /EXCT12AB34CD/);
  const row = await api.db.outgoingTransaction.findUnique({ where: { plaidTransactionId: 'email:msg-1' } });
  assert.equal(row!.status, 'APPLIED');
  // The same email again: nothing more.
  assert.equal((await recordOutgoingP2P(ids.user, sent('Sam Example', 1250, '1200 Elm Grove Ln November 2026 Payment'), 'msg-1')).outcome, 'skipped');
  // The bank's line for it finds the email's row.
  const { emailTwin } = await import('../../src/services/outgoingP2PEmails');
  assert.equal((await emailTwin(ids.user, ids.bank, 1250, new Date('2026-11-12T00:00:00Z')))!.id, row!.id);
});

test('no name on file: the memo\'s property and the payment amount find the loan', { skip }, async () => {
  const { recordOutgoingP2P } = await import('../../src/services/outgoingP2PEmails');
  const r = await recordOutgoingP2P(ids.user, sent('Jordan Trustee', 900, '12 Pine Ct Nov payment'), 'msg-2');
  assert.equal(r.outcome, 'loan');
  assert.equal(await api.db.loanPayment.count({ where: { loanId: ids.pine } }), 1);
});

test('a near miss waits for review; a payment to no lender is only noted', { skip }, async () => {
  const { recordOutgoingP2P } = await import('../../src/services/outgoingP2PEmails');
  // Two loans from Sam Example and no address: not sure which.
  const r = await recordOutgoingP2P(ids.user, sent('Sam Example', 1250, null, '2026-12-01'), 'msg-3');
  assert.equal(r.outcome, 'review');
  assert.equal((await api.db.outgoingTransaction.findUnique({ where: { plaidTransactionId: 'email:msg-3' } }))!.status, 'SUGGESTED');
  const none = await recordOutgoingP2P(ids.user, sent('Riley Doe', 75, 'yard work'), 'msg-4');
  assert.equal(none.outcome, 'skipped');
  assert.equal(await api.db.outgoingTransaction.count({ where: { plaidTransactionId: 'email:msg-4' } }), 0);
});
