/**
 * A "you sent money" email is a loan payment when it surely is one: by the lender's name, the memo's
 * address picking between a lender's loans or finding the loan when the name is not on file, the memo's
 * month; once only; a near miss waits under Finances → Loans → Payments to check. Made-up names and amounts.
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

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${api.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('Payments to check: the near miss is listed, put on the right loan and logged for the memo\'s month', { skip }, async () => {
  const { recordOutgoingP2P } = await import('../../src/services/outgoingP2PEmails');
  // Two loans from Sam Example, a memo naming the month but not the property.
  const r = await recordOutgoingP2P(ids.user, sent('Sam Example', 1250, 'October 2026 Payment', '2026-11-03'), 'msg-5');
  assert.equal(r.outcome, 'review');
  const list = await (await send('GET', '/expense-transactions?matchType=LOAN&status=SUGGESTED,UNMATCHED')).json() as any[];
  const row = list.find(t => t.name.includes('October 2026'));
  assert.ok(row, 'the near miss is listed');
  assert.equal(row.source, 'email');
  assert.equal(row.loan.lender, 'Sam Example');
  assert.equal(row.loan.expected, 1250);
  assert.equal(row.plaidTransactionId, undefined);
  // The owner picks the 88 Oak Hollow Rd loan and logs it: October, from the memo.
  assert.equal((await send('PATCH', `/expense-transactions/${row.id}`, { loanId: ids.oak })).status, 200);
  assert.equal((await send('POST', `/expense-transactions/${row.id}/apply`)).status, 200);
  const pay = await api.db.loanPayment.findFirst({ where: { loanId: ids.oak, amount: 1250, date: new Date('2026-11-03T00:00:00Z') } });
  assert.equal(pay!.periodDate!.toISOString().slice(0, 7), '2026-10');
  const applied = await (await send('GET', '/expense-transactions?matchType=LOAN&status=APPLIED&days=3650')).json() as any[];
  assert.equal(applied.find(t => t.id === row.id).loggedFor, '2026-10');
});

test('Payments to check: a chosen month wins; ignore and restore', { skip }, async () => {
  const { recordOutgoingP2P } = await import('../../src/services/outgoingP2PEmails');
  await recordOutgoingP2P(ids.user, sent('Sam Example', 1250, null, '2026-12-20'), 'msg-6');
  const row = (await (await send('GET', '/expense-transactions?matchType=LOAN&status=SUGGESTED')).json() as any[]).find(t => t.date.startsWith('2026-12-20'));
  assert.equal((await send('POST', `/expense-transactions/${row.id}/ignore`)).status, 200);
  assert.equal((await send('POST', `/expense-transactions/${row.id}/restore`)).status, 200);
  assert.equal((await api.db.outgoingTransaction.findUnique({ where: { id: row.id } }))!.status, 'SUGGESTED');
  assert.equal((await send('PATCH', `/expense-transactions/${row.id}`, { loanId: ids.elm })).status, 200);
  assert.equal((await send('POST', `/expense-transactions/${row.id}/apply`, { periodMonth: '2027-01' })).status, 200);
  const pay = await api.db.loanPayment.findFirst({ where: { loanId: ids.elm, date: new Date('2026-12-20T00:00:00Z') } });
  assert.equal(pay!.periodDate!.toISOString().slice(0, 7), '2027-01');
});

test('a maybe from an account not in Sollux is noted for the owner, not skipped', { skip }, async () => {
  const { recordOutgoingP2P } = await import('../../src/services/outgoingP2PEmails');
  const r = await recordOutgoingP2P(ids.user, { ...sent('Sam Example', 1250, null, '2026-12-28'), fromLast4: '9999' }, 'msg-7');
  assert.equal(r.outcome, 'review');
  assert.match(r.detail, /··9999 is not in Sollux/);
  assert.equal(await api.db.outgoingTransaction.count({ where: { plaidTransactionId: 'email:msg-7' } }), 0);
});
