/** Cards filed more than once are found and merged into one in a click. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00Z`);

before(async () => {
  if (skip) return;
  api = await startApi();
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const mk = async (name: string, statements: [string, number][]) => {
    const c = await db.creditCard.create({ data: { userId: me.id, name } });
    for (const [closing, bal] of statements) await db.cardStatement.create({ data: { cardId: c.id, closingDate: d(closing), dueDate: d(closing.replace(/-(\d\d)-/, (_, m) => `-${String(Number(m) + 1).padStart(2, '0')}-`)), newBalance: bal, minimumPayment: 41 } });
    return c.id;
  };
  ids.a = await mk('PayPal Credit (Synchrony Bank)', [['2026-10-12', 1101.09]]);
  ids.b = await mk('PayPal Credit', [['2026-10-12', 1101.09]]);
  ids.c = await mk('PayPal Credit', [['2026-11-12', 1684.73]]);
  ids.other = await mk('Apple Card', [['2026-10-31', 100]]);
});
after(async () => { if (!skip) await api.stop(); });

const send = (method: string, path: string, body?: unknown) => fetch(`${api.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('three copies of one account become one card with both statements', { skip }, async () => {
  const groups = await (await send('GET', '/credit-cards/duplicates')).json() as any[];
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keepId, ids.c);
  const r = await send('POST', '/credit-cards/merge-group', { keepId: groups[0].keepId, cardIds: groups[0].cardIds });
  assert.equal(r.status, 200);
  const cards = await api.db.creditCard.findMany({ include: { statements: { orderBy: { closingDate: 'asc' } } } });
  const paypal = cards.filter(c => /PayPal/.test(c.name));
  assert.equal(paypal.length, 1);
  assert.deepEqual(paypal[0].statements.map(s => s.closingDate.toISOString().slice(0, 10)), ['2026-10-12', '2026-11-12']);
  assert.equal(paypal[0].statementClosingDay, 12);
  assert.deepEqual(await (await send('GET', '/credit-cards/duplicates')).json(), []);
});
