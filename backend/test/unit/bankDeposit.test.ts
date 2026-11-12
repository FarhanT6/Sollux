/** Reading a bank deposit of checks: the read cleaned, and a check split between rent and utilities. Made-up amounts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRead, splitCheck } from '../../src/services/bankDeposit';

test('the read: one entry per check, numbers as numbers, the account\'s last 4 digits only', () => {
  const r = cleanRead({
    bank: 'Example Bank', accountLast4: 'xxxx-xx12-9173', postDate: '2026-11-10', total: '$2,673.57', checkCount: 3,
    checks: [
      { index: 1, amount: '1,310.79', payer: ' Jordan Sample ', checkNumber: '#1042', memo: 'Nov rent + water' },
      { index: 2, amount: 629.1, payer: null },
      { index: 2, amount: 629.1, payer: 'duplicate from a second screenshot' },
      { index: 3, amount: 733.68, checkDate: '11/08/2026' },
      { index: 4, amount: 0 },
    ],
  });
  assert.equal(r.accountLast4, '9173');
  assert.equal(r.total, 2673.57);
  assert.deepEqual(r.checks.map(c => [c.index, c.amount]), [[1, 1310.79], [2, 629.1], [3, 733.68]]);
  assert.equal(r.checks[0].payer, 'Jordan Sample');
  assert.equal(r.checks[0].checkNumber, '1042');
  assert.equal(r.checks[2].checkDate, null);
});

test('a check splits: the month\'s rent first, then utilities; a utilities memo goes to utilities', () => {
  assert.deepEqual(splitCheck(1310.79, 1200, 110.79, 'November rent'), { rent: 1200, utilities: 110.79 });
  assert.deepEqual(splitCheck(1000, 1200, 110.79, null), { rent: 1000, utilities: 0 });
  // Rent already paid this month: all of it goes to utilities (owed or not).
  assert.deepEqual(splitCheck(150, 0, 110.79, null), { rent: 0, utilities: 150 });
  assert.deepEqual(splitCheck(110.79, 1200, 110.79, 'water bill'), { rent: 0, utilities: 110.79 });
});
