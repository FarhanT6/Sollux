/** When Sollux fetches on its own, and where each account stands for a month. Made-up dates. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWait, monthState, monthBounds, nextScheduleRun, statementVia } from '../../src/lib/fetchPlan';
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
