/** Card statements with no last four find their card by name; email stand-ins give way to the statement; two cards merge into one. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
let svc: typeof import('../../src/services/cardIntake');
let userId = '';

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  svc = await import('../../src/services/cardIntake');
  const me = await api.db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  userId = me.id;
  // Two other cards from the same issuer, so "the only card from this issuer" cannot decide.
  await api.db.creditCard.create({ data: { userId, name: 'Example Store Card ••1111', issuer: 'Sample Bank', last4: '1111' } });
  await api.db.creditCard.create({ data: { userId, name: 'Example Pro Card ••2222', issuer: 'Sample Bank', last4: '2222' } });
});
after(async () => { if (!skip) await api.stop(); });

const ex = (o: Record<string, unknown>) => ({ providerName: 'Sample Bank', accountNumber: null, ...o }) as any;

test('statements with no last four go to the card of the same name; the email stand-in gives way', { skip }, async () => {
  const a = await svc.fileCardStatement(userId, ex({ fromEmailBody: true, creditCard: { cardName: 'Demo Credit', issuer: 'Sample Bank', closingDate: '2026-09-18', newBalance: 500, minimumPayment: 25, dueDate: '2026-10-12' } }), null, 'Your statement is ready.pdf');
  assert.equal(a.created, true);
  const b = await svc.fileCardStatement(userId, ex({ creditCard: { cardName: 'Demo Credit (Sample Bank)', issuer: 'Sample Bank', closingDate: '2026-09-20', newBalance: 500, minimumPayment: 25 } }), null, 'statement.pdf');
  assert.equal(b.cardId, a.cardId, 'the same card, by name');
  const sts = await api.db.cardStatement.findMany({ where: { cardId: a.cardId } });
  assert.deepEqual(sts.map(s => [s.closingDate.toISOString().slice(0, 10), s.fromEmail]), [['2026-09-20', false]], 'the email stand-in was replaced');
  const c = await svc.fileCardStatement(userId, ex({ fromEmailBody: true, creditCard: { cardName: 'Demo Credit', issuer: 'Sample Bank', closingDate: '2026-09-19', newBalance: 500 } }), null, 'Your payment is due.pdf');
  assert.equal(c.cardId, a.cardId);
  assert.equal(await api.db.cardStatement.count({ where: { cardId: a.cardId } }), 1, 'a later email for the same cycle adds nothing');
});

test('two cards merge: statements, transactions and payments move, repeats once', { skip }, async () => {
  const from = await api.db.creditCard.create({ data: { userId, name: 'Demo Twin', creditLimit: 3000 } });
  const into = await api.db.creditCard.create({ data: { userId, name: 'Demo Twin' } });
  const d = new Date('2026-08-18T00:00:00Z');
  await api.db.cardStatement.create({ data: { cardId: from.id, closingDate: d, newBalance: 100 } });
  await api.db.cardStatement.create({ data: { cardId: into.id, closingDate: d, newBalance: 100 } });
  await api.db.cardStatement.create({ data: { cardId: from.id, closingDate: new Date('2026-07-18T00:00:00Z'), newBalance: 90 } });
  await api.db.cardTransaction.create({ data: { cardId: from.id, date: d, description: 'Coffee', amount: 4.5, kind: 'PURCHASE' } as any });
  await api.db.cardTransaction.create({ data: { cardId: into.id, date: d, description: 'Coffee', amount: 4.5, kind: 'PURCHASE' } as any });
  await api.db.cardPayment.create({ data: { cardId: from.id, date: d, amount: 50 } });
  const r = await svc.mergeCards(userId, from.id, into.id);
  assert.deepEqual(r, { statements: 1, transactions: 0, payments: 1 });
  assert.equal(await api.db.creditCard.count({ where: { id: from.id } }), 0);
  assert.equal(await api.db.cardStatement.count({ where: { cardId: into.id } }), 2);
  assert.equal(await api.db.cardTransaction.count({ where: { cardId: into.id } }), 1);
  assert.equal(Number((await api.db.creditCard.findUnique({ where: { id: into.id } }))!.creditLimit), 3000, 'the limit it lacked was filled in');
});
