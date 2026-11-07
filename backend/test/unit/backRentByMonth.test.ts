import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backRentByMonth } from '../../src/lib/rentDue';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

test('back rent sits on the newest months; older months are paid', () => {
  const m = backRentByMonth({ rentAmount: 3000, startDate: d('2024-01-01'), arrearsBalance: 10000, arrearsCaughtUpThrough: d('2026-10-01') });
  assert.equal(m.get('2026-10'), 3000);
  assert.equal(m.get('2026-08'), 3000);
  assert.equal(m.get('2026-07'), 1000);
  assert.equal(m.get('2026-06'), 0);
  assert.equal(m.get('2026-11'), undefined);
});

test('never before the lease began', () => {
  const m = backRentByMonth({ rentAmount: 1000, startDate: d('2026-09-01'), arrearsBalance: 5000, arrearsCaughtUpThrough: d('2026-10-01') });
  assert.deepEqual([...m.entries()], [['2026-10', 1000], ['2026-09', 1000]]);
});
