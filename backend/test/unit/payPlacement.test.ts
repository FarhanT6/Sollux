/**
 * Placing payments one account each (the pay planner never splits a payment): the
 * placement that leaves the least to make up, then the fewest accounts short, then the
 * usual accounts, then the most left in the lowest account. Made-up amounts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeOneEach, moveWords } from '../../src/lib/payPlan';

const it = (amount: number, usual = -1) => ({ amount, usual });

test('finds the placement where nothing is short when plain "most room first" would leave one short', () => {
  // Most room first: 4,000 → A (2,000 left), 3,000 → B (1,000 left), 3,000 fits nowhere.
  // Both 3,000s on A and the 4,000 on B fits exactly.
  const pick = placeOneEach([it(4000), it(3000), it(3000)], [6000, 4000]);
  const left = [6000, 4000];
  pick.forEach((a, i) => { left[a] -= [4000, 3000, 3000][i]; });
  assert.ok(left.every(r => r >= 0), `nothing short: ${left}`);
});

test('a payment stays on its usual account when that leaves nothing short', () => {
  const pick = placeOneEach([it(1000, 1)], [9000, 2000]);
  assert.deepEqual(pick, [1]);
});

test('leaves its usual account when that would make one come up short', () => {
  const pick = placeOneEach([it(5000, 1), it(1500, 1)], [6000, 5200]);
  // The usual account (B) can't carry both: one moves to A, nothing is short, and of the two ways
  // the one leaving the lowest account highest is taken (5,000 on A: 1,000 and 3,700 left).
  assert.equal(pick.filter(a => a === 1).length, 1);
  assert.deepEqual(pick, [0, 1]);
});

test('when something must be short, it is the least, in one account, and never a split', () => {
  // 10,250 + 5,600 + 3,900 against 9,000 / 12,000 / 3,000: the least short is 500, both small ones on 9,000.
  const amounts = [10250, 5600, 3900];
  const room = [9000, 12000, 3000];
  const pick = placeOneEach(amounts.map(a => it(a)), room);
  const left = [...room];
  pick.forEach((a, i) => { left[a] -= amounts[i]; });
  const short = left.filter(r => r < 0);
  assert.equal(short.length, 1);
  assert.equal(short[0], -500);
});

test('ties go to the placement that leaves the lowest account highest', () => {
  const pick = placeOneEach([it(1000)], [5000, 3000]);
  assert.deepEqual(pick, [0]);
});

test('a large plan still returns one account per payment within its budget', () => {
  const items = Array.from({ length: 14 }, (_, i) => it(500 + i * 37));
  const pick = placeOneEach(items, [4000, 3500, 3000, 2500, 2000, 1500], 5000);
  assert.equal(pick.length, items.length);
  assert.ok(pick.every(a => a >= 0 && a < 6));
});

test('moves are worded by what they are', () => {
  assert.equal(moveWords({ kind: 'DEPOSIT', from: 'Checks on hand', amount: 500 }), 'deposit $500.00 of checks on hand');
  assert.equal(moveWords({ kind: 'DEPOSIT', from: 'Cash', amount: 200 }), 'deposit $200.00 cash');
  assert.equal(moveWords({ kind: 'DEPOSIT', from: 'Apple Cash', amount: 80 }), 'move $80.00 from Apple Cash');
  assert.equal(moveWords({ kind: 'DEPOSIT', from: 'Cash App', amount: 80 }), 'move $80.00 from Cash App');
  assert.equal(moveWords({ kind: 'TRANSFER', from: 'Savings ...2222', amount: 300 }), 'transfer $300.00 from Savings ...2222');
});
