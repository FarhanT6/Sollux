/** Which of the bank's lines a pending item is: one of its amount, one per check of a deposit, or credits that add up. Made-up amounts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linesForItem } from '../../src/services/pendingMoney';

const at = (s: string) => new Date(`${s}T00:00:00Z`).getTime();
const credit = (id: string, amount: number, date: string) => ({ id, amount: -amount, date });

test('a deposit the bank posted as one credit, days later', () => {
  const hit = linesForItem({ amount: 4075, direction: 'IN', made: at('2026-11-09'), checks: [1200, 1000, 975, 900] },
    [credit('a', 1850, '2026-11-08'), credit('b', 4075, '2026-11-10')]);
  assert.deepEqual(hit?.map(l => l.id), ['b']);
});

test('a deposit of four checks the bank posted check by check', () => {
  const lines = [credit('x', 1000, '2026-11-10'), credit('y', 1200, '2026-11-10'), credit('z', 900, '2026-11-12'), credit('w', 975, '2026-11-10'), credit('v', 75, '2026-11-11')];
  const hit = linesForItem({ amount: 4075, direction: 'IN', made: at('2026-11-09'), checks: [1200, 1000, 975, 900] }, lines);
  assert.deepEqual(hit?.map(l => l.id).sort(), ['w', 'x', 'y', 'z']);
});

test('credits that add up when the checks are not known one by one', () => {
  const hit = linesForItem({ amount: 640, direction: 'IN', made: at('2026-11-09'), checks: [] },
    [credit('a', 400, '2026-11-10'), credit('b', 240, '2026-11-11'), credit('c', 99, '2026-11-10')]);
  assert.deepEqual(hit?.map(l => l.id).sort(), ['a', 'b']);
});

test('nothing from before the deposit, nothing the wrong way, no sums for money going out', () => {
  assert.equal(linesForItem({ amount: 500, direction: 'IN', made: at('2026-11-09'), checks: [] }, [credit('old', 500, '2026-11-01')]), null);
  assert.equal(linesForItem({ amount: 500, direction: 'IN', made: at('2026-11-09'), checks: [] }, [{ id: 'out', amount: 500, date: '2026-11-10' }]), null);
  assert.equal(linesForItem({ amount: 500, direction: 'OUT', made: at('2026-11-09'), checks: [] }, [{ id: 'a', amount: 300, date: '2026-11-10' }, { id: 'b', amount: 200, date: '2026-11-10' }]), null);
  assert.deepEqual(linesForItem({ amount: 1100, direction: 'OUT', made: at('2026-11-09'), checks: [] }, [{ id: 'chk', amount: 1100, date: '2026-11-20' }])?.map(l => l.id), ['chk']);
});

test('a loan sheet that says the check is dropped off reads as a check handed over, not mailed', async () => {
  const { methodsFrom } = await import('../../src/services/loanPaymentDetails');
  assert.deepEqual(methodsFrom('Drop off check at the office'), ['CHECK_DROPPED']);
  assert.deepEqual(methodsFrom('Mail check to PO Box 100'), ['CHECK']);
  assert.deepEqual(methodsFrom('Zelle or check in person'), ['CHECK_DROPPED', 'ZELLE']);
});
