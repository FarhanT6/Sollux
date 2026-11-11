/**
 * The statement schedule and the month view on Settings → AI usage: one fetch
 * per login, led by the account on it that is due (the first account found
 * used to decide for the whole login); accounts with nothing to fetch with
 * are left to email; each account's month says on file, coming, late or why.
 * Made-up providers, logins and dates.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const NOW = new Date('2026-11-11T18:00:00Z');
const d = (s: string) => new Date(`${s}T00:00:00Z`);

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
  const { encrypt } = await import('../../src/crypto/encrypt');
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(NOW.getTime() + 10 * 86_400_000) } });
  ids.user = me.id;
  const prop = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const login = { usernameEnc: encrypt('owner@example.com'), passwordEnc: encrypt('not-a-real-password') };
  const acct = async (key: string, data: Record<string, unknown>, dates: string[]) => {
    const a = await db.utilityAccount.create({ data: { propertyId: prop.id, category: 'ELECTRIC', billingCadence: 'MONTHLY', ...data } as any });
    for (const s of dates) await db.statement.create({ data: { utilityAccountId: a.id, statementDate: d(s), amountDue: 100, rawDataJson: { source: key === 'email' ? 'email' : 'portal' } } as any });
    ids[key] = a.id;
  };
  // One login, two accounts billed on different days: the first's next bill is weeks off, the second's is late.
  await acct('notDue', { providerName: 'Example Power', providerSlug: 'example-power', loginUrl: 'https://www.example-power.com', accountNumber: '1111', ...login }, ['2026-10-28', '2026-09-28', '2026-08-28']);
  await acct('late', { providerName: 'Example Power', providerSlug: 'example-power', loginUrl: 'https://www.example-power.com', accountNumber: '2222', ...login }, ['2026-10-02', '2026-09-02', '2026-08-02']);
  // On file this month, from email; and one with no login saved.
  await acct('email', { providerName: 'Example Water', providerSlug: 'example-water', loginUrl: 'https://www.example-water.gov', accountNumber: '3333', ...login }, ['2026-11-04', '2026-10-04', '2026-09-04']);
  await acct('noLogin', { providerName: 'Example Trash', providerSlug: 'gmail-fallback', accountNumber: '4444' }, ['2026-10-01', '2026-09-01']);
});
after(async () => {
  if (skip) return;
  // The queue's Redis connection keeps the test process alive otherwise.
  const queues = await import('../../src/workers/queues') as Record<string, any>;
  for (const q of Object.values(queues)) {
    if (q && typeof q.disconnect === 'function') await Promise.resolve(q.disconnect()).catch(() => {});
  }
  const { db } = await import('../../src/config/db');
  await db.$disconnect().catch(() => {});
  await api.stop();
});

test('one fetch per login, led by the account on it that is due; none without a login', { skip }, async () => {
  const { scheduleAllScrapes } = await import('../../src/services/fetchScheduler');
  const { scrapeQueue } = await import('../../src/workers/queues');
  const r = await scheduleAllScrapes(NOW);
  assert.equal(r.queued, 1);
  assert.equal(r.accounts, 3);
  const slot = Math.floor(NOW.getTime() / (6 * 3_600_000));
  assert.ok(await scrapeQueue.getJob(`sched-${ids.late}-${slot}`), 'the due account leads its login\'s fetch');
  assert.equal(await scrapeQueue.getJob(`sched-${ids.notDue}-${slot}`), undefined);
  assert.equal(await scrapeQueue.getJob(`sched-${ids.noLogin}-${slot}`), undefined);
  await scrapeQueue.remove(`sched-${ids.late}-${slot}`);
});

test('the schedule runs when its last run is 6 hours old, and survives a restart', { skip }, async () => {
  const { scheduleTick, lastScheduleRun } = await import('../../src/services/fetchScheduler');
  assert.equal(await scheduleTick(NOW), true);
  assert.equal((await lastScheduleRun())!.toISOString(), NOW.toISOString());
  assert.equal(await scheduleTick(new Date(NOW.getTime() + 2 * 3_600_000)), false);
  assert.equal(await scheduleTick(new Date(NOW.getTime() + 6 * 3_600_000)), true);
  const { scrapeQueue } = await import('../../src/workers/queues');
  await scrapeQueue.obliterate({ force: true }).catch(() => {});
});

test('the month: on file and how, late and why, nothing to fetch with', { skip }, async () => {
  const { fetchMonth } = await import('../../src/services/fetchMonth');
  await api.db.syncJob.create({ data: { utilityAccountId: ids.late, status: 'SUCCESS', startedAt: d('2026-11-08'), completedAt: d('2026-11-08'), statementsFound: 0, createdAt: d('2026-11-08') } });
  const m = await fetchMonth(ids.user, '2026-11', NOW);
  const of = (k: string) => m.accounts.find(a => a.id === ids[k])!;
  assert.equal(of('email').state, 'got');
  assert.equal(of('email').got!.via, 'email');
  assert.equal(of('notDue').state, 'coming');
  assert.match(of('notDue').why, /expected about Nov 28/);
  assert.equal(of('late').state, 'late');
  assert.equal(of('late').triesSinceDue, 1);
  assert.match(of('late').why, /Tried 1 time since; it was not on the website yet/);
  assert.ok(of('late').nextTry);
  assert.equal(of('noLogin').state, 'late');
  assert.equal(of('noLogin').fetchable, false);
  assert.match(of('noLogin').why, /cannot fetch it/);
  assert.deepEqual(m.counts, { got: 1, coming: 1, due: 0, late: 2, 'not-this-month': 0, 'no-history': 0 });
});

test('fetch the late ones: one run per login, none for an account with nothing to fetch with', { skip }, async () => {
  const res = await fetch(`${api.url}/api/ai-spend/fetch-month/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [ids.late, ids.notDue, ids.noLogin] }) });
  assert.equal(res.status, 200);
  const r = await res.json() as { queued: number; accounts: number };
  assert.equal(r.accounts, 2);
  assert.equal(r.queued, 1);
  const view = await (await fetch(`${api.url}/api/ai-spend/fetch-month`)).json() as { accounts: { id: string }[]; schedule: unknown };
  assert.ok(view.accounts.some(a => a.id === ids.late));
  assert.ok(view.schedule);
  const { scrapeQueue } = await import('../../src/workers/queues');
  await scrapeQueue.obliterate({ force: true }).catch(() => {});
});
