/** Reading a bank deposit of checks: the read cleaned, and a check split between rent and utilities. Made-up amounts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRead, splitCheck } from '../../src/services/bankDeposit';

test('the read: one entry per check, numbers as numbers, the account\'s last 4 digits only', () => {
  const r = cleanRead({
    bank: 'Example Bank', accountLast4: 'xxxx-xx12-2222', postDate: '2026-11-10', total: '$2,642.80', checkCount: 3,
    checks: [
      { index: 1, amount: '1,285.40', payer: ' Jordan Sample ', checkNumber: '#1042', memo: 'Nov rent + water' },
      { index: 2, amount: 615.25, payer: null },
      { index: 2, amount: 615.25, payer: 'duplicate from a second screenshot' },
      { index: 3, amount: 742.15, checkDate: '11/08/2026' },
      { index: 4, amount: 0 },
    ],
  });
  assert.equal(r.accountLast4, '2222');
  assert.equal(r.total, 2642.80);
  assert.deepEqual(r.checks.map(c => [c.index, c.amount]), [[1, 1285.40], [2, 615.25], [3, 742.15]]);
  assert.equal(r.checks[0].payer, 'Jordan Sample');
  assert.equal(r.checks[0].checkNumber, '1042');
  assert.equal(r.checks[2].checkDate, null);
});

test('a check splits: the month\'s rent first, then utilities; a utilities memo goes to utilities', () => {
  assert.deepEqual(splitCheck(1285.40, 1200, 85.40, 'November rent'), { rent: 1200, utilities: 85.40 });
  assert.deepEqual(splitCheck(1000, 1200, 85.40, null), { rent: 1000, utilities: 0 });
  // Rent already paid this month: all of it goes to utilities (owed or not).
  assert.deepEqual(splitCheck(150, 0, 85.40, null), { rent: 0, utilities: 150 });
  assert.deepEqual(splitCheck(85.40, 1200, 85.40, 'water bill'), { rent: 0, utilities: 85.40 });
});
