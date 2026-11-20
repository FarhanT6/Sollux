/** When Sollux fetches on its own, and where each account stands for a month. Made-up dates. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWait, monthState, monthBounds, nextScheduleRun, statementVia, usualStatementDay, nextStatementAfter, midnightAfter } from '../../src/lib/fetchPlan';
import { billCycleDays, learnedCycleDays } from '../../src/lib/billCadence';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const at = (s: string) => new Date(s);

test('not before the next bill is due; a bill-ready email is believed 10 days early', () => {
  const base = { nextOn: d('2026-11-20'), lastStatementDate: d('2026-10-20'), lastRun: null, misses: 0 };
  const w = fetchWait({ ...base, now: d('2026-11-05') });
  assert.match(w.skip ?? '', /next is expected about 2026-11-20/);
  assert.equal(w.nextAt.toISOString().slice(0, 10), '2026-11-20');
  assert.equal(fetchWait({ ...base, now: d('2026-11-12'), billPosted: true }).skip, null);
  assert.equal(fetchWait({ ...base, now: d('2026-11-21') }).skip, null);
});

test('never twice in 20 hours; runs that found nothing back off 1, 2, 4, then 7 days', () => {
  const base = { nextOn: d('2026-11-01'), lastStatementDate: d('2026-10-01'), now: at('2026-11-10T12:00:00Z') };
  assert.equal(fetchWait({ ...base, lastRun: at('2026-11-10T00:00:00Z'), misses: 1 }).skip, 'already ran today');
  assert.equal(fetchWait({ ...base, lastRun: at('2026-11-09T00:00:00Z'), misses: 1 }).skip, null);
  const two = fetchWait({ ...base, lastRun: at('2026-11-09T00:00:00Z'), misses: 2 });
  assert.match(two.skip ?? '', /2 runs since the last statement found nothing/);
  assert.equal(two.nextAt.toISOString(), '2026-11-11T00:00:00.000Z');
  const many = fetchWait({ ...base, lastRun: at('2026-11-05T00:00:00Z'), misses: 9 });
  assert.equal(many.nextAt.toISOString(), '2026-11-12T00:00:00.000Z');
});

test('the schedule\'s next run at or after a time', () => {
  const last = at('2026-11-10T03:00:00Z'), now = at('2026-11-10T05:00:00Z');
  assert.equal(nextScheduleRun(now, last, now).toISOString(), '2026-11-10T09:00:00.000Z');
  assert.equal(nextScheduleRun(at('2026-11-12T10:00:00Z'), last, now).toISOString(), '2026-11-12T15:00:00.000Z');
  // Never ran: from now.
  assert.equal(nextScheduleRun(now, null, now).toISOString(), now.toISOString());
});

test('a month: on file, coming, due, late, not billed this month, no history', () => {
  const nov = monthBounds('2026-11');
  const monthly = [{ statementDate: d('2026-10-04') }, { statementDate: d('2026-09-04') }];
  assert.equal(monthState([{ statementDate: d('2026-11-03') }, ...monthly], 30, nov, d('2026-11-11')).state, 'got');
  // Due about Nov 3: on the 11th, more than 5 days past, it is late.
  const late = monthState(monthly, 30, nov, d('2026-11-11'));
  assert.equal(late.state, 'late');
  assert.equal(late.expectedOn!.toISOString().slice(0, 10), '2026-11-03');
  assert.equal(monthState(monthly, 30, nov, d('2026-11-05')).state, 'due');
  assert.equal(monthState([{ statementDate: d('2026-10-25') }], 30, nov, d('2026-11-11')).state, 'coming');
  // Every two months, billed in October: not this month.
  assert.equal(monthState([{ statementDate: d('2026-10-10') }], 60, nov, d('2026-11-11')).state, 'not-this-month');
  assert.equal(monthState([], 30, nov, d('2026-11-11')).state, 'no-history');
  // A bill missed in October is still late in November.
  assert.equal(monthState([{ statementDate: d('2026-09-01') }], 30, nov, d('2026-11-11')).state, 'late');
});

test('how a statement came in', () => {
  assert.equal(statementVia({ rawDataJson: { source: 'email' }, sourceType: 'MANUAL' }), 'email');
  assert.equal(statementVia({ rawDataJson: { source: 'portal' }, sourceType: 'MANUAL' }), 'portal');
  assert.equal(statementVia({ rawDataJson: null, sourceType: 'SCRAPER' }), 'portal');
  assert.equal(statementVia({ rawDataJson: { source: 'pdf_import' }, sourceType: 'MANUAL' }), 'upload');
  assert.equal(statementVia({ rawDataJson: null, sourceType: 'MANUAL' }), 'typed');
});

test('a policy billed once a term is not checked monthly', () => {
  assert.equal(billCycleDays('TERM', 6), 183);
  assert.equal(billCycleDays('TERM', null), 30);
  assert.equal(learnedCycleDays([d('2026-06-01')], 'TERM', 12).days, 365);
});

test('a monthly bill is expected on the day of the month its statements usually come out', () => {
  // Mailed the 14th, 12th, 15th, 13th, 13th: the 13th. The longest gap (33 days) put it on the 16th.
  const hist = ['2026-10-14', '2026-09-12', '2026-08-15', '2026-07-13', '2026-06-13'].map(d);
  assert.equal(usualStatementDay(hist), 13);
  assert.equal(nextStatementAfter(d('2026-10-14'), hist, 33).toISOString().slice(0, 10), '2026-11-13');
  // The day is kept in a short month: the 31st usual, February's last day.
  const late = ['2026-01-31', '2025-12-31', '2025-11-30', '2025-10-31'].map(d);
  assert.equal(nextStatementAfter(d('2026-01-31'), late, 31).toISOString().slice(0, 10), '2026-02-28');
  // Either side of a month's turn (the 30th, then the 2nd) is no day pattern: the cycle.
  const turn = ['2026-10-02', '2026-08-30', '2026-08-01', '2026-06-29'].map(d);
  assert.equal(usualStatementDay(turn), null);
  assert.equal(nextStatementAfter(d('2026-10-02'), turn, 32).toISOString().slice(0, 10), '2026-11-03');
  // Every two months: the cycle.
  const bimonthly = ['2026-09-10', '2026-07-11', '2026-05-09'].map(d);
  assert.equal(usualStatementDay(bimonthly), null);
  // Too little on file: the cycle.
  assert.equal(usualStatementDay([d('2026-10-14'), d('2026-09-13')]), null);
});

test('fetched at midnight Pacific after the statement day', () => {
  assert.equal(midnightAfter(d('2026-11-13'), 'America/Los_Angeles').toISOString(), '2026-11-14T08:00:00.000Z');   // PST
  assert.equal(midnightAfter(d('2026-07-13'), 'America/Los_Angeles').toISOString(), '2026-07-14T07:00:00.000Z');   // PDT
  assert.equal(midnightAfter(d('2026-12-31'), 'UTC').toISOString(), '2027-01-01T00:00:00.000Z');
});

test('a statement expected the 13th is fetched at midnight after it, and a run before then does not count', () => {
  const nextOn = d('2026-11-13'), fetchAt = midnightAfter(nextOn, 'America/Los_Angeles');
  const base = { nextOn, fetchAt, lastStatementDate: d('2026-10-14'), misses: 0 };
  // The 13th, mid-afternoon: not yet; held for midnight.
  const before = fetchWait({ ...base, now: at('2026-11-13T22:00:00Z'), lastRun: null });
  assert.match(before.skip ?? '', /next is expected about 2026-11-13/);
  assert.equal(before.nextAt.toISOString(), '2026-11-14T08:00:00.000Z');
  // Midnight: runs, though another account on the login ran three hours before.
  assert.equal(fetchWait({ ...base, now: at('2026-11-14T08:00:00Z'), lastRun: at('2026-11-14T05:00:00Z') }).skip, null);
  // Not out at midnight: the next night.
  const missed = fetchWait({ ...base, now: at('2026-11-14T12:00:00Z'), lastRun: at('2026-11-14T08:05:00Z'), misses: 1 });
  assert.equal(missed.skip, 'already ran today');
  assert.equal(fetchWait({ ...base, now: at('2026-11-15T08:05:00Z'), lastRun: at('2026-11-14T08:05:00Z'), misses: 1 }).skip, null);
});
