import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrearsAsOf } from '../../src/lib/arrearsAsOf';

const lease = { rentAmount: 3700, startDate: new Date('2025-01-01T00:00:00Z') };
const pay = (paid: string, period: string, amount: number, toArrears = amount) =>
  ({ id: paid + amount, amount, appliedToArrears: toArrears, periodDate: new Date(`${period}-01T00:00:00Z`), paidDate: new Date(`${paid}T00:00:00Z`), status: 'RECEIVED' });

test('a notice figure carried forward: payments since come off, an ended month goes on', () => {
  const payments = [
    pay('2026-09-14', '2026-09', 600),            // before the notice: already in its figure
    pay('2026-10-05', '2026-10', 500), pay('2026-10-05', '2026-10', 600), pay('2026-10-10', '2026-10', 500),
    pay('2026-10-17', '2026-10', 1000), pay('2026-10-28', '2026-10', 1000), pay('2026-10-31', '2026-10', 600),
  ];
  const r = arrearsAsOf({ lease, amount: 22550, through: '2026-09', asOf: '2026-10-05', today: '2026-11-02', payments, charges: [] });
  // 22,550 − 4,200 paid since + October's 3,700 (all of October's money went to the balance).
  assert.equal(r.balance, 22050);
  assert.equal(r.lastRolled, '2026-10');
});

test('a payment credited to an ended month reduces what that month adds', () => {
  const r = arrearsAsOf({ lease, amount: 1000, through: '2026-09', asOf: '2026-10-01', today: '2026-11-02', payments: [pay('2026-10-03', '2026-10', 3700, 0)], charges: [] });
  assert.equal(r.balance, 1000);
});
