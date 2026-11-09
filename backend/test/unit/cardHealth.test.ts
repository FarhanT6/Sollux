import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardHealth } from '../../src/lib/cardHealth';
import { cardInsights } from '../../src/lib/cardInsights';

const st = (id: string, closing: string, due: string, min: number, newBalance: number, over: Record<string, unknown> = {}) =>
  ({ id, closingDate: closing, dueDate: due, minimumPayment: min, newBalance, ...over });
const today = new Date('2026-11-20T12:00:00Z');

// A payment that bounced, the late fee for the missed date (statement not on file) and its refund, then on-time months.
const statements = [
  st('jun', '2026-06-11', '2026-07-08', 25, 200),
  st('jul', '2026-07-12', '2026-08-08', 25, 1300, { lines: [
    { date: '2026-06-12', amount: 1000, kind: 'PAYMENT', description: 'PAYMENT REVERSAL' },
    { date: '2026-06-12', amount: 25, kind: 'FEE', description: 'PREVIOUS CYCLE LATE FEE' },
    { date: '2026-06-12', amount: 25, kind: 'FEE', description: 'RETURNED CHECK CHG' },
  ] }),
  st('aug', '2026-08-12', '2026-09-08', 25, 1250, { lines: [{ date: '2026-07-13', amount: -25, kind: 'CREDIT', description: 'Late Fee Credit' }] }),
  st('sep', '2026-09-11', '2026-10-08', 25, 1225, { interestCharged: 10 }),
  st('oct', '2026-10-12', '2026-11-08', 25, 1200),
];
const payments = [
  { date: '2026-06-08', amount: 1000 }, { date: '2026-06-12', amount: -1000 },  // paid, then returned
  { date: '2026-06-15', amount: 100 }, { date: '2026-08-08', amount: 25 }, { date: '2026-09-08', amount: 25 }, { date: '2026-10-08', amount: 25 },
];

test('payment history: on time by the due date, a returned payment does not count, a late fee is a late payment', () => {
  const h = cardHealth(statements, payments, today);
  assert.deepEqual(h.history.map(r => [r.closingDate, r.status, r.paidOn]), [
    ['2026-10-12', 'PAST_DUE', null],
    ['2026-09-11', 'ON_TIME', '2026-10-08'],
    ['2026-08-12', 'ON_TIME', '2026-09-08'],
    ['2026-07-12', 'ON_TIME', '2026-07-13'],   // its minimum was the late fee, given back on Jul 13
    ['2026-06-11', 'ON_TIME', '2026-06-15'],
  ]);
  assert.deepEqual(h.returned, [{ paidOn: '2026-06-08', returnedOn: '2026-06-12', amount: 1000 }]);
  assert.deepEqual(h.lateEvents.map(e => [e.date, e.fee, e.waived, e.waivedOn, e.onFile]), [['2026-06-12', 25, true, '2026-07-13', false]]);
  assert.equal(h.daysPastDue, 12);
  assert.equal(h.daysUntil30, 18);
  assert.equal(h.last12.late, 2);  // the late fee's missed date, and October unpaid today
  // Costs: one late fee, one returned-check fee, the late fee refunded, $10 interest.
  assert.deepEqual([h.allTime.lateFees, h.allTime.otherFees, h.allTime.refunds, h.allTime.interest, h.allTime.net], [25, 25, 25, 10, 35]);
});

test('paid after the due date is late by the days; reported only when 30+ days past due on a statement date', () => {
  const h = cardHealth([st('a', '2026-01-10', '2026-02-05', 30, 500), st('b', '2026-02-10', '2026-03-05', 30, 480)],
    [{ date: '2026-02-20', amount: 30 }, { date: '2026-04-20', amount: 30 }], today);
  const [b, a] = h.history;
  assert.deepEqual([a.status, a.daysLate, a.reported], ['LATE', 15, null]);
  assert.equal(b.status, 'LATE');
  // Still unpaid when the Apr 10 statement closed, 36 days after its due date.
  assert.deepEqual([b.daysLate, b.pastDueAtStatement, b.reported], [46, { date: '2026-04-10', days: 36 }, '30']);
  // Paid the day before that statement date instead: 35 days late, but only 5 past due on a statement date — not reported.
  const early = cardHealth([st('a', '2026-01-10', '2026-02-05', 30, 500), st('b', '2026-02-10', '2026-03-05', 30, 480)],
    [{ date: '2026-02-20', amount: 30 }, { date: '2026-04-09', amount: 30 }], today).history[0];
  assert.deepEqual([early.daysLate, early.pastDueAtStatement, early.reported], [35, { date: '2026-03-10', days: 5 }, null]);
});

test('a minimum that includes the past-due amount is not counted twice (the Chase pattern)', () => {
  // Made-up amounts in the shape of a real account: each minimum prints the past-due amount it includes.
  const sts = [
    st('feb', '2026-02-03', '2026-02-28', 500, 18000, { pastDueAmount: 0 }),
    // February's 500 unpaid at closing: 500 past due + 520 of its own, and a $40 late fee given back next cycle.
    st('mar', '2026-03-03', '2026-03-28', 1020, 18400, { pastDueAmount: 500 }),
    st('apr', '2026-04-03', '2026-04-28', 530, 17900, { pastDueAmount: 0, lines: [{ date: '2026-03-01', amount: -40, kind: 'CREDIT', description: 'Late Fee Reversal' }] }),
    st('may', '2026-05-03', '2026-05-28', 540, 17800, { pastDueAmount: 0 }),
    st('jun', '2026-06-03', '2026-06-28', 550, 17700, { pastDueAmount: 0 }),
    // June's 550 unpaid at closing; the printed figure is not on this one (read before past-due amounts were kept).
    st('jul', '2026-07-03', '2026-07-28', 1110, 17900),
    st('aug', '2026-08-03', '2026-08-28', 1130, 18000, { pastDueAmount: 560 }),
    st('sep', '2026-09-03', '2026-09-28', 575, 17800, { pastDueAmount: 0 }),
  ];
  const pays = [
    { date: '2026-03-25', amount: 500 }, { date: '2026-03-28', amount: 479.95 }, { date: '2026-04-26', amount: 530 }, { date: '2026-05-31', amount: 540 },
    { date: '2026-07-28', amount: 550 }, { date: '2026-08-27', amount: 560 }, { date: '2026-08-28', amount: 570 }, { date: '2026-10-01', amount: 575 },
  ];
  const h = cardHealth(sts, pays, today);
  const row = (id: string) => h.history.find(r => r.statementId === id)!;
  assert.deepEqual([row('feb').status, row('feb').daysLate, row('feb').reported], ['LATE', 25, null]);
  // 500 + 479.95 + the $40 given back meets the 520 March owed beyond February's: on time.
  assert.deepEqual([row('mar').status, row('mar').paidOn], ['ON_TIME', '2026-03-28']);
  assert.equal(row('apr').status, 'ON_TIME');
  assert.deepEqual([row('may').daysLate, row('jun').daysLate, row('jul').daysLate, row('sep').daysLate], [3, 30, 30, 3]);
  assert.deepEqual([row('jun').pastDueAtStatement, row('jul').pastDueAtStatement], [{ date: '2026-07-03', days: 5 }, { date: '2026-08-03', days: 6 }]);
  assert.equal(row('aug').status, 'ON_TIME');
  // Nothing was ever 30 days past due on a statement date: nothing reported.
  assert.deepEqual(h.history.filter(r => r.reported), []);
});

test('nothing logged but the next statement shows nothing past due: probably paid, not late', () => {
  const h = cardHealth([st('a', '2026-01-10', '2026-02-05', 30, 500), st('b', '2026-02-10', '2026-03-05', 30, 470, { pastDueAmount: 0 })], [], today);
  assert.equal(h.history[1].status, 'NOT_LOGGED');
});

test('insights: past due with days to the 30-day mark, a promotion off pace, utilization, pay-down order', () => {
  const h = cardHealth(statements, payments, today);
  const base = { status: 'ACTIVE', autopay: 'NONE', minPayoffMonths: 144 };
  const { insights, snapshot } = cardInsights([
    { ...base, id: 'hd', name: 'Store Card', phone: '1-800-555-0100', health: h, paid90: 75, promotions: [{ balance: 1200, payBy: '2027-12-08' }],
      position: { balance: 1200, limit: 3000, utilization: 40, apr: 29.99, introActive: true, monthlyInterest: 0, minimumPayment: 25, statementStatus: 'DUE', minimumRemaining: 25, nextDueDate: '2026-11-08' } },
    { ...base, id: 'b', name: 'Bank Card', health: cardHealth([], [], today), paid90: 600, promotions: [],
      position: { balance: 5000, limit: 6000, utilization: 83.3, apr: 24, introActive: false, monthlyInterest: 100, minimumPayment: 110, statementStatus: 'DUE', minimumRemaining: 0, nextDueDate: '2026-12-01' } },
  ], today);
  const kinds = insights.map(i => `${i.kind}:${i.cardId ?? '-'}`);
  assert.ok(kinds.includes('PAST_DUE:hd'));
  assert.match(insights.find(i => i.kind === 'PAST_DUE')!.title, /12 days past due/);
  assert.ok(kinds.includes('PROMO_PACE:hd'));
  assert.ok(kinds.includes('FEE_WAIVER:hd'));
  assert.match(insights.find(i => i.kind === 'FEE_WAIVER')!.script ?? '', /reverse/);
  assert.equal(insights.find(i => i.kind === 'LATE_FEES')!.script, null);  // its late fee was refunded already
  assert.ok(kinds.includes('UTILIZATION:b'));
  assert.ok(kinds.includes('MIN_VS_INTEREST:b'));
  assert.equal(insights.find(i => i.kind === 'PAYDOWN_ORDER')!.cardId, 'b');
  assert.equal(insights[0].severity, 'ALERT');
  assert.equal(snapshot.utilization, 68.9);
  assert.equal(snapshot.paymentHistory, 'FAIR');
});
