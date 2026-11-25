/**
 * The setup checklist (services/setupChecklist.ts) read live, made-up account: a property, one
 * inbox whose last read failed, a bank that hasn't synced in a week, a login the site rejected,
 * a connector that went quiet and a loan without its last 4.
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
  await db.gmailToken.create({ data: { userId: me.id, email: 'bills@example.com', accessToken: 'x', refreshToken: 'x', expiresAt: new Date(), lastScanAt: daysAgo(1), lastScanError: 'invalid_grant' } });
  await db.plaidItem.create({ data: { userId: me.id, plaidItemId: 'item-sample', accessTokenEnc: 'x', institutionId: 'ins_1', institutionName: 'Sample Bank', lastSyncedAt: daysAgo(7) } });
  await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample Electric', providerSlug: 'gmail-fallback', category: 'ELECTRIC', usernameEnc: 'x', lastSyncStatus: 'FAILED', lastSyncError: 'The site rejected the username or password' } });
  await db.connectorDevice.create({ data: { userId: me.id, name: 'Office PC', tokenHash: 'h', lastSeenAt: daysAgo(2) } });
  await db.loan.create({ data: { userId: me.id, propertyId: p.id, lender: 'Sample Lender', loanType: 'MORTGAGE', monthlyPayment: 1000 } });
});
after(async () => { if (!skip) await api.stop(); });

test('the checklist reads what is connected and what needs a look', { skip }, async () => {
  const res = await fetch(`${api.url}/api/dashboard/setup`);
  assert.equal(res.status, 200);
  const body = await res.json() as { done: number; total: number; items: { key: string; state: string; detail: string }[] };
  const by = Object.fromEntries(body.items.map(i => [i.key, i]));
  assert.equal(by.properties.state, 'done');
  assert.equal(by.email.state, 'warn');
  assert.match(by.email.detail, /invalid_grant/);
  assert.equal(by.bank.state, 'warn');
  assert.match(by.bank.detail, /Sample Bank hasn't synced since 7 days ago/);
  assert.equal(by.logins.state, 'warn');
  assert.equal(by.connector.state, 'warn');
  assert.match(by.connector.detail, /Office PC is offline/);
  assert.equal(by.alerts.state, 'todo');
  assert.equal(by.loans.state, 'warn');
  assert.ok(body.total >= 7 && body.done >= 1, JSON.stringify(body));
});
