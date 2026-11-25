/**
 * "Needs you" (services/needsYou.ts) lists what waits on the owner, made-up figures: a login the
 * website rejected, a bill whose charge plus carried balance isn't its printed total, a loan
 * payment to check, a tenant transfer to confirm — and leaves out a site that blocks robots from
 * the count, a bill the owner edited, and an account whose sync failed for Sollux's own reasons.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, type TestApi } from './server';

let api: TestApi;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

before(async () => {
  if (skip) return;
  api = await startApi();
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'PRIMARY' } });
  const acct = (providerName: string, extra: Record<string, unknown> = {}) =>
    db.utilityAccount.create({ data: { propertyId: p.id, providerName, providerSlug: 'gmail-fallback', category: 'ELECTRIC', ...extra } });
  await acct('Sample Electric', { lastSyncStatus: 'FAILED', lastSyncError: 'Login failed: the site said the password is incorrect' });
  await acct('Sample Water', { lastSyncStatus: 'FAILED', lastSyncError: 'The site blocked automated sign-in (captcha)' });
  await acct('Sample Gas', { lastSyncStatus: 'FAILED', lastSyncError: 'Browser crashed: Target closed' });
  const bills = await acct('Sample Trash');
  // Charge $80 + carried $40 = $120, but the bill printed $150: doesn't add up.
  await db.statement.create({ data: { utilityAccountId: bills.id, statementDate: daysAgo(20), amountDue: 80, pastDueCarried: 40, rawDataJson: { source: 'portal', statedTotalDue: 150 } } });
  // The same, edited by the owner: left alone.
  await db.statement.create({ data: { utilityAccountId: bills.id, statementDate: daysAgo(50), amountDue: 80, pastDueCarried: 40, rawDataJson: { source: 'portal', statedTotalDue: 150, ownerEditedAt: '2026-10-01T00:00:00Z' } } });
  // One that adds up.
  await db.statement.create({ data: { utilityAccountId: bills.id, statementDate: daysAgo(80), amountDue: 80, pastDueCarried: 40, rawDataJson: { source: 'portal', statedTotalDue: 120 } } });
  const bank = await db.bankAccount.create({ data: { userId: me.id, name: 'Sample Checking', last4: '1234', accountType: 'CHECKING' } });
  await db.outgoingTransaction.create({ data: { userId: me.id, bankAccountId: bank.id, plaidTransactionId: 'email:sample-1', amount: 612.5, date: daysAgo(5), name: 'You sent $612.50 to Sample Lender', matchType: 'LOAN', status: 'SUGGESTED' } });
  await db.incomingTransaction.create({ data: { userId: me.id, plaidTransactionId: 'zelle-sample-1', amount: 1_250, date: daysAgo(3), name: 'JORDAN SAMPLE', channel: 'ZELLE', status: 'UNMATCHED' } });
});
after(async () => { if (!skip) await api.stop(); });

test('Needs you lists the login, the bill that does not add up, the loan payment and the transfer', { skip }, async () => {
  const res = await fetch(`${api.url}/api/dashboard/needs-you`);
  assert.equal(res.status, 200);
  const body = await res.json() as { total: number; sections: { key: string; count: number; items: { title: string; detail?: string; to: string }[] }[] };
  const by = Object.fromEntries(body.sections.map(s => [s.key, s]));
  assert.equal(by.logins?.count, 1, JSON.stringify(body));
  assert.match(by.logins.items[0].title, /Sample Electric/);
  assert.match(by.logins.items[0].to, /^\/properties\/[^/]+\/utilities\/[^/]+$/);
  assert.equal(by.blocked?.count, 1);
  assert.equal(by.figures?.count, 1);
  assert.match(by.figures.items[0].detail ?? '', /Read \$120\.00 · printed \$150\.00/);
  assert.equal(by['loan-payments']?.count, 1);
  assert.equal(by.transfers?.count, 1);
  // The blocked site is listed but not counted; the crashed sync is Sollux's to fix, not the owner's.
  assert.equal(body.total, 4);
});
