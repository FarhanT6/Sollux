/** Rent caught up: from move-in, never over a logged payment, at the rent then in effect. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rentMonthsToCatchUp, rentInMonth } from '../../src/lib/rentCatchUp';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

test('from the move-in month, prorated, through the chosen month', () => {
  const months = rentMonthsToCatchUp({ rentAmount: 3000, startDate: d('2026-06-16') }, [], new Set(), '2026-09');
  assert.deepEqual(months.map(m => m.month), ['2026-06', '2026-07', '2026-08', '2026-09']);
  assert.equal(months[0].amount, 1500); // 15 of 30 June days
  assert.equal(months[1].amount, 3000);
});

test('a month with any payment logged is left alone', () => {
  const months = rentMonthsToCatchUp({ rentAmount: 2000, startDate: d('2026-01-01') }, [], new Set(['2026-02', '2026-03']), '2026-04');
  assert.deepEqual(months.map(m => m.month), ['2026-01', '2026-04']);
});

test('each month at the rent then in effect', () => {
  const changes = [{ effectiveDate: d('2026-03-01'), previousAmount: 1800, newAmount: 2000 }];
  assert.equal(rentInMonth(2000, changes, '2026-02'), 1800);
  assert.equal(rentInMonth(2000, changes, '2026-03'), 2000);
  const months = rentMonthsToCatchUp({ rentAmount: 2000, startDate: d('2026-01-01') }, changes, new Set(), '2026-03');
  assert.deepEqual(months.map(m => m.amount), [1800, 1800, 2000]);
});

test('no move-in date, nothing is logged', () => {
  assert.equal(rentMonthsToCatchUp({ rentAmount: 2000, startDate: null }, [], new Set(), '2026-09').length, 0);
});
