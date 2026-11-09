/** When a card's statement is fetched from its website without anyone asking, and where the agent starts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardFetchSkip, nextClosing } from '../../src/lib/cardFetchSchedule';
import { cardStartUrl, cardIssuerSite, asUrl } from '../../src/lib/cardIssuerSites';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
const base = { autoFetch: true, closed: false, closingDay: 12, lastRunAt: null, misses: 0, newestSavedAt: null };

test('the next closing date is the card\'s closing day in the following month, clamped to the month', () => {
  assert.equal(iso(nextClosing(d('2026-10-12'), 12)), '2026-11-12');
  assert.equal(iso(nextClosing(d('2026-01-31'), null)), '2026-02-28');
  assert.equal(iso(nextClosing(d('2026-12-12'), 12)), '2027-01-12');
  assert.equal(iso(nextClosing(d('2026-01-30'), 31)), '2026-02-28');
});

test('not before the next statement can be out; a ready email is believed a few days early', () => {
  const s = { ...base, newestClosing: d('2026-10-12') };
  assert.match(cardFetchSkip({ ...s, now: d('2026-11-13') }) ?? '', /next closes about 2026-11-12/);
  assert.equal(cardFetchSkip({ ...s, now: d('2026-11-16') }), null);
  assert.equal(cardFetchSkip({ ...s, now: d('2026-11-10'), billPosted: true }), null);
});

test('never twice in a day, and runs that found nothing back off until a statement comes in', () => {
  const s = { ...base, newestClosing: d('2026-10-12'), now: d('2026-11-20') };
  assert.equal(cardFetchSkip({ ...s, lastRunAt: new Date(d('2026-11-20').getTime() - 3_600_000) }), 'already ran today');
  // Three empty runs: wait 4 days after the last.
  assert.match(cardFetchSkip({ ...s, misses: 3, lastRunAt: d('2026-11-18') }) ?? '', /3 runs .* next try in 2 day/);
  assert.equal(cardFetchSkip({ ...s, misses: 3, lastRunAt: d('2026-11-15') }), null);
  // A statement saved since the last run (uploaded, or from email) starts the count again.
  assert.equal(cardFetchSkip({ ...s, misses: 6, lastRunAt: d('2026-11-18'), newestSavedAt: d('2026-11-19') }), null);
});

test('off, closed, or no statement on file yet', () => {
  assert.match(cardFetchSkip({ ...base, autoFetch: false, newestClosing: null, now: d('2026-11-20') }) ?? '', /off/);
  assert.match(cardFetchSkip({ ...base, closed: true, newestClosing: null, now: d('2026-11-20') }) ?? '', /closed/);
  assert.equal(cardFetchSkip({ ...base, newestClosing: null, now: d('2026-11-20') }), null);
});

test('the agent starts on the saved page, else the one the statement prints, else the issuer\'s site', () => {
  assert.equal(cardStartUrl({ issuer: 'Citibank', loginUrl: 'www.example-store.com/mycard' }, 'https://login.example-bank.com/signin'), 'https://login.example-bank.com/signin');
  assert.equal(cardStartUrl({ issuer: 'Citibank', loginUrl: 'www.example-store.com/mycard' }), 'https://www.example-store.com/mycard');
  assert.equal(cardStartUrl({ issuer: 'Citibank', name: 'Home Depot Consumer Credit Card' }), 'https://www.citi.com');
  assert.equal(cardIssuerSite({ issuer: 'Synchrony Bank', name: 'PayPal Credit' }), 'https://www.paypal.com');
  assert.equal(cardIssuerSite({ name: 'Amazon Store Card' }), 'https://www.mysynchrony.com');
  assert.equal(cardIssuerSite({ name: 'Prime Visa', issuer: 'Chase' }), 'https://www.chase.com');
  assert.equal(cardIssuerSite({ name: 'Mystery card' }), null);
  assert.equal(asUrl('not a site'), null);
});
