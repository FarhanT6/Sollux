import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateGroups } from '../../src/lib/cardDuplicates';

const card = (id: string, name: string, last4: string | null, statements: [string, number][], memberId: string | null = null) =>
  ({ id, name, last4, status: 'ACTIVE', memberId, createdAt: `2026-0${id.length}-01`, statements: statements.map(([d, b]) => ({ closingDate: d, newBalance: b })) });

test('no card number, same name: one account; the card with the newest statement is kept', () => {
  const g = duplicateGroups([
    card('a', 'PayPal Credit (Synchrony Bank)', null, [['2026-10-12', 1101.09]], 'm1'),
    card('b', 'PayPal Credit', null, [['2026-10-12', 1101.09]]),
    card('c', 'PayPal Credit', null, [['2026-11-12', 1684.73]]),
    card('d', 'Apple Card', null, [['2026-10-31', 4456.31]]),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].keepId, 'c');
  assert.deepEqual([...g[0].cardIds].sort(), ['a', 'b', 'c']);
  assert.match(g[0].reason, /same statement \(2026-10-12/);
  assert.equal(g[0].differentOwners, true);
});

test('different card numbers are never one account, whatever the name; the same number is', () => {
  assert.deepEqual(duplicateGroups([
    card('a', 'The Home Depot Consumer Credit Card (Citi)', '9198', []),
    card('b', 'The Home Depot Consumer Credit Card (Citi)', '8137', []),
  ]), []);
  const g = duplicateGroups([card('a', 'Chase Sapphire', '2419', []), card('b', 'Sapphire Preferred', '2419', [['2026-10-28', 10]])]);
  assert.equal(g[0].keepId, 'b');
});
