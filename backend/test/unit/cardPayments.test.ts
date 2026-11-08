import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLines, ON_STATEMENT } from '../../src/services/cardPayments';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const pay = (id: string, date: string, amount: number, over: Record<string, unknown> = {}) => ({ id, date: d(date), amount, postedStatementId: null, method: null, ...over });

test('a logged payment is the statement line it posted as, a few days apart', () => {
  assert.deepEqual(matchLines([{ date: d('2026-10-08'), amount: 29 }], [pay('p1', '2026-10-06', 29)], 's1'), ['p1']);
});

test('a different amount, or a payment far from the line, is not the same payment', () => {
  assert.deepEqual(matchLines([{ date: d('2026-10-08'), amount: 29 }], [pay('p1', '2026-10-06', 30), pay('p2', '2026-09-20', 29)], 's1'), [null]);
});

test('two equal payments match two lines, never one twice', () => {
  const lines = [{ date: d('2026-09-01'), amount: 50 }, { date: d('2026-09-15'), amount: 50 }];
  assert.deepEqual(matchLines(lines, [pay('a', '2026-09-14', 50), pay('b', '2026-08-31', 50)], 's1'), ['b', 'a']);
});

test("a payment posted on another statement is not taken; the owner's own is preferred to one read from a statement", () => {
  const line = [{ date: d('2026-10-08'), amount: 29 }];
  assert.deepEqual(matchLines(line, [pay('other', '2026-10-07', 29, { postedStatementId: 's0' })], 's1'), [null]);
  assert.deepEqual(matchLines(line, [pay('read', '2026-10-08', 29, { method: ON_STATEMENT }), pay('mine', '2026-10-05', 29)], 's1'), ['mine']);
});

test('the same confirmation number matches even a week apart; a reversed payment matches only a reversal', () => {
  assert.deepEqual(matchLines([{ date: d('2026-10-08'), amount: 29, reference: 'P632139753156462' }], [pay('p1', '2026-10-01', 29, { confirmation: '632139753156462' })], 's1'), ['p1']);
  assert.deepEqual(matchLines([{ date: d('2026-06-12'), amount: -1436.14 }], [pay('p1', '2026-06-08', 1436.14)], 's1'), [null]);
});
