/** Property tax rules by state: installment dates, defaults, redemption, sale dates. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarFor, defaultTimeline, redemptionEstimate, nextBusinessDay, monthsFrom, installmentStatus, firstYear } from '../../src/lib/propertyTaxRules';

test('California fiscal year: Nov 1 / Dec 10 and Feb 1 / Apr 10, weekends move to Monday', () => {
  const cal = calendarFor('CA', '2026-2027')!;
  assert.equal(cal.yearLabel, '2026-27');
  assert.deepEqual(cal.installments.map(i => [i.due, i.delinquentAfter]), [['2026-11-01', '2026-12-10'], ['2027-02-01', '2027-04-12']]); // Apr 10, 2027 is a Saturday
  assert.equal(nextBusinessDay('2028-12-10'), '2028-12-11');                                                                          // a Sunday
  assert.equal(firstYear('FY 2025/26'), 2025);
});

test('a delinquent California installment carries 10%, the second also $10', () => {
  const [i1, i2] = calendarFor('CA', '2026-27')!.installments;
  assert.deepEqual(installmentStatus(i1, 1000, null, '2026-12-11'), { state: 'delinquent', penalty: 100 });
  assert.deepEqual(installmentStatus(i2, 1000, null, '2027-04-13'), { state: 'delinquent', penalty: 110 });
  assert.equal(installmentStatus(i1, 1000, '2026-12-01', '2027-01-01').state, 'paid');
  assert.equal(installmentStatus(i1, 1000, null, '2026-11-15').state, 'due');
});

test('California default: July 1 after the fiscal year, power to sell in 5 years (3 for commercial)', () => {
  const tl = defaultTimeline('CA', '2022-23')!;
  assert.equal(tl.defaultDate, '2023-07-01');
  assert.equal(tl.powerToSell, '2028-07-01');
  assert.equal(tl.powerToSellCommercial, '2026-07-01');
});

test('California redemption: tax, penalties, costs, $15 and 1.5% a month on the tax', () => {
  assert.equal(monthsFrom('2025-07-01', '2025-07-01'), 1);
  assert.equal(monthsFrom('2025-07-01', '2025-09-30'), 3);
  const r = redemptionEstimate('CA', { tax: 2000, penalties: 210, costs: 0, defaultDate: '2025-07-01' }, '2026-06-30')!;
  assert.equal(r.months, 12);
  assert.equal(r.total, 2000 + 210 + 360 + 15);
});

test('Florida: discounts, April 1 delinquency, certificate deed in 2 years, void in 7', () => {
  const cal = calendarFor('FL', '2026')!;
  assert.deepEqual(cal.discounts!.map(d => d.rate), [0.04, 0.03, 0.02, 0.01]);
  assert.equal(cal.discounts![3].by, '2027-02-28');
  const tl = defaultTimeline('FL', '2026', { certificateIssued: '2027-05-28' })!;
  assert.equal(tl.defaultDate, '2027-04-01');
  assert.equal(tl.deedEligible, '2029-04-01');
  assert.equal(tl.certificateExpires, '2034-05-28');
});

test('a state without rules gets none (the bill\'s own dates stand)', () => {
  assert.equal(calendarFor('OH', '2026'), null);
  assert.equal(defaultTimeline('OH', '2026'), null);
});

test('lookup starts on the county site Sollux knows, a Florida county-taxes page, or a search', async () => {
  const { startUrlFor, cleanReport } = await import('../../src/lib/taxLookupReport');
  assert.equal(startUrlFor('FL', 'Brevard County', '123'), 'https://brevard.county-taxes.com/public');
  assert.equal(startUrlFor('FL', 'St. Lucie', '123'), 'https://stlucie.county-taxes.com/public');
  assert.match(startUrlFor('OH', 'Franklin', '010-000123'), /^https:\/\/duckduckgo\.com\/html\/\?q=franklin%20county%20OH%20/);

  // What the agent reports is typed and trimmed; malformed entries are dropped.
  const r = cleanReport({
    found: true, sourceUrl: 'javascript:alert(1)',
    years: [{ taxYear: '2026-27', installment1Amount: '1,200.50', installment1Due: '2026-11-01', exemptionsValue: -7000, specialAssessments: [{ name: 'CFD 2006-1', amount: 300 }, { name: '', amount: 5 }] }, { annualTaxAmount: 9 }],
    defaults: [{ taxYear: '2022-23', defaultNumber: 'DEF230000001', defaultDate: 'July 1', amountToRedeem: 4100 }],
  });
  assert.equal(r.sourceUrl, null);
  assert.equal(r.years!.length, 1);
  assert.equal(r.years![0].installment1Amount, 1200.5);
  assert.equal(r.years![0].exemptionsValue, 7000);
  assert.deepEqual(r.years![0].specialAssessments, [{ name: 'CFD 2006-1', amount: 300, phone: null, cfd: true }]);
  assert.equal(r.defaults![0].defaultDate, null);
});

test('a parcel found by address is ours only when the street number and name agree', async () => {
  const { sameStreetAddress } = await import('../../src/lib/taxLookupReport');
  assert.equal(sameStreetAddress('1200 Elm Grove Ln', '1200 ELM GROVE LANE ESCONDIDO CA 92029'), true);
  assert.equal(sameStreetAddress('1200 N Elm Grove Ln', '1200 ELM GROVE LN'), true);
  assert.equal(sameStreetAddress('1200 Elm Grove Ln', '1204 ELM GROVE LN'), false);
  assert.equal(sameStreetAddress('1200 Elm Grove Ln', '1200 OAK ST'), false);
  assert.equal(sameStreetAddress('1200 Elm Grove Ln', null), false);
});
