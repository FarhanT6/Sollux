import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnedCycleDays } from '../../src/lib/billCadence';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

test("a monthly bill that runs 28 to 33 days is fetched on the longest usual gap", () => {
  const r = learnedCycleDays([d('2026-10-26'), d('2026-09-25'), d('2026-08-23'), d('2026-07-24'), d('2026-06-23')], 'MONTHLY');
  assert.deepEqual(r, { days: 33, learned: true });
});

test('a missing bill (a doubled gap) is set aside', () => {
  const r = learnedCycleDays([d('2026-10-20'), d('2026-08-20'), d('2026-07-21'), d('2026-06-20')], 'MONTHLY');
  assert.deepEqual(r, { days: 31, learned: true });
});

test('too little history falls back to the cadence', () => {
  assert.deepEqual(learnedCycleDays([d('2026-10-20'), d('2026-09-20')], 'BIMONTHLY'), { days: 60, learned: false });
});
