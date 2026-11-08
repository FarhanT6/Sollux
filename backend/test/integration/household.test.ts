/** People in the household: cards and loans are theirs, each person's list is their own, and removing a person gives their things back. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};

before(async () => {
  if (skip) return;
  api = await startApi();
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  ids.user = me.id;
  ids.mine = (await db.creditCard.create({ data: { userId: me.id, name: 'Example Rewards' } })).id;
  ids.theirs = (await db.creditCard.create({ data: { userId: me.id, name: 'Sample Cash Back' } })).id;
  ids.loan = (await db.loan.create({ data: { userId: me.id, lender: 'Example Auto Finance', loanType: 'AUTO', isPersonal: true, currentBalance: 9000 } as any })).id;
});
after(async () => { if (!skip) await api.stop(); });

const send = (method: string, path: string, body?: unknown) => fetch(`${api.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('a person, their card and loan, each list filtered to them, and removed', { skip }, async () => {
  const dad = await (await send('POST', '/household', { name: 'Dad' })).json() as any;
  assert.equal((await send('POST', '/household/assign', { kind: 'card', id: ids.theirs, memberId: dad.id })).status, 200);
  assert.equal((await send('POST', '/household/assign', { kind: 'loan', id: ids.loan, memberId: dad.id })).status, 200);

  const dadCards = await (await send('GET', `/credit-cards?member=${dad.id}`)).json() as any;
  assert.deepEqual(dadCards.cards.map((c: any) => c.id), [ids.theirs]);
  const myCards = await (await send('GET', '/credit-cards?member=me')).json() as any;
  assert.deepEqual(myCards.cards.map((c: any) => c.id), [ids.mine]);
  const all = await (await send('GET', '/credit-cards')).json() as any;
  assert.equal(all.cards.length, 2);
  const dadLoans = await (await send('GET', `/loans?isPersonal=true&member=${dad.id}`)).json() as any[];
  assert.deepEqual(dadLoans.map(l => l.id), [ids.loan]);

  const h = await (await send('GET', '/household')).json() as any;
  assert.deepEqual(h.members[0].linked, { cards: 1, loans: 1, bills: 0 });

  assert.equal((await send('DELETE', `/household/${dad.id}`)).status, 204);
  const back = await api.db.creditCard.findUnique({ where: { id: ids.theirs } });
  assert.equal(back!.memberId, null);
});

test('someone else\'s person cannot be assigned', { skip }, async () => {
  const other = await api.db.householdMember.create({ data: { userId: 'someone-else', name: 'Stranger' } });
  assert.equal((await send('POST', '/household/assign', { kind: 'card', id: ids.mine, memberId: other.id })).status, 404);
});
