/**
 * A card's website login for fetching its statements: stored encrypted, never
 * returned; Fetch now queues one run at a time; a fetched statement is filed to
 * the card it was fetched for unless it prints another card's last four; a
 * merged card keeps the login.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = TEST_DB;
  api = await startApi();
  const me = await api.db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  ids.user = me.id;
  ids.card = (await api.db.creditCard.create({ data: { userId: me.id, name: 'Store Card', issuer: 'Citibank', last4: '1111', loginUrl: 'www.example-store.com/mycard' } })).id;
  ids.other = (await api.db.creditCard.create({ data: { userId: me.id, name: 'Rewards Card', issuer: 'Citibank', last4: '2222' } })).id;
  ids.copy = (await api.db.creditCard.create({ data: { userId: me.id, name: 'Store Card' } })).id;
});
after(async () => { if (!skip) await api.stop(); });

const send = (method: string, path: string, body?: unknown) => fetch(`${api.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('the login is stored encrypted and only the username comes back', { skip }, async () => {
  let r = await send('PUT', `/credit-cards/${ids.card}/login`, { username: 'owner-login' });
  assert.equal(r.status, 400, 'a new login needs both');
  r = await send('PUT', `/credit-cards/${ids.card}/login`, { username: 'owner-login', password: 'not-a-real-password' });
  assert.equal(r.status, 200);
  const state = await r.json() as any;
  assert.equal(state.hasLogin, true);
  assert.equal(state.username, 'owner-login');
  assert.equal(state.startUrl, 'https://www.example-store.com/mycard');
  const raw = JSON.stringify(state);
  assert.ok(!/not-a-real-password|Enc/.test(raw));
  const row = await api.db.cardLogin.findUnique({ where: { cardId: ids.card } });
  assert.ok(row && row.passwordEnc !== 'not-a-real-password' && row.usernameEnc !== 'owner-login');
  // The card itself, and the list, carry nothing of the login.
  for (const path of [`/credit-cards/${ids.card}`, '/credit-cards']) {
    const body = await (await send('GET', path)).text();
    assert.ok(!/not-a-real-password|usernameEnc|passwordEnc|owner-login/.test(body), path);
  }
  // A blank password keeps the saved one.
  r = await send('PUT', `/credit-cards/${ids.card}/login`, { username: 'owner-login-2', loginUrl: 'login.example-bank.com' });
  assert.equal(r.status, 200);
  const after = await api.db.cardLogin.findUnique({ where: { cardId: ids.card } });
  assert.equal(after!.passwordEnc, row!.passwordEnc);
  assert.equal(after!.loginUrl, 'https://login.example-bank.com/');
});

test('Fetch now runs one at a time; Cancel stops it; a code is only taken while one is asked for', { skip }, async () => {
  let r = await send('POST', `/credit-cards/${ids.other}/fetch`);
  assert.equal(r.status, 400, 'no login yet');
  r = await send('POST', `/credit-cards/${ids.card}/fetch`);
  assert.equal(r.status, 202);
  assert.equal(((await r.json()) as any).fetch.status, 'PENDING');
  r = await send('POST', `/credit-cards/${ids.card}/fetch`);
  assert.equal(r.status, 409);
  r = await send('POST', `/credit-cards/${ids.card}/fetch/code`, { code: '123456' });
  assert.equal(r.status, 409);
  await api.db.cardLogin.update({ where: { cardId: ids.card }, data: { mfaPrompt: 'Enter the code we texted you' } });
  r = await send('POST', `/credit-cards/${ids.card}/fetch/code`, { code: '123456' });
  assert.equal(r.status, 204);
  const row = await api.db.cardLogin.findUnique({ where: { cardId: ids.card } });
  assert.ok(row!.mfaCodeEnc && row!.mfaCodeEnc !== '123456');
  r = await send('POST', `/credit-cards/${ids.card}/fetch/cancel`);
  const state = await r.json() as any;
  assert.equal(state.fetch.status, 'CANCELLED');
  assert.equal(state.fetch.mfaPrompt, null);
});

test('a fetched statement goes to the card it was fetched for, unless it prints another card\'s number', { skip }, async () => {
  const { fileCardStatement } = await import('../../src/services/cardIntake');
  const ex = (last4: string | null, closing: string) => ({
    documentKind: 'credit_card_statement', providerName: 'Citibank', statementDate: closing,
    creditCard: { last4, cardName: 'Citi card', issuer: 'Citibank', closingDate: closing, newBalance: 120.5, minimumPayment: 35, dueDate: '2026-12-07' },
  }) as any;
  // No last four printed: the fetched card, not a new one or the other Citi card.
  let r = await fileCardStatement(ids.user, ex(null, '2026-11-10'), null, 'statement.pdf', { cardId: ids.card });
  assert.equal(r.cardId, ids.card);
  assert.equal(r.created, false);
  // The same login showed the other card's statement: it is that card's.
  r = await fileCardStatement(ids.user, ex('2222', '2026-11-10'), null, 'statement.pdf', { cardId: ids.card });
  assert.equal(r.cardId, ids.other);
});

test('merging a card into another takes its login along', { skip }, async () => {
  const r = await send('POST', `/credit-cards/${ids.card}/merge`, { intoId: ids.copy });
  assert.equal(r.status, 200);
  const login = await api.db.cardLogin.findUnique({ where: { cardId: ids.copy } });
  assert.ok(login, 'the login moved');
  assert.equal(await api.db.cardLogin.count({ where: { cardId: ids.card } }), 0);
  const del = await send('DELETE', `/credit-cards/${ids.copy}/login`);
  assert.equal(del.status, 204);
  assert.equal(await api.db.cardLogin.count(), 0);
});
