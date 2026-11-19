/**
 * Look up all runs one property first: the rest wait and start only if it works, so a lookup
 * failing for a reason they all share costs one lookup, not all of them. Without the owner's
 * connector online nothing starts unless they say to run it anyway. Made-up properties.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const DAY = 86_400_000;

before(async () => {
  if (skip) return;
  // No AI key: a lookup fails at once ("AI is not configured") — a first lookup that does not work.
  api = await startApi({ ANTHROPIC_API_KEY: '' });
  process.env.DATABASE_URL = TEST_DB;
  delete process.env.ANTHROPIC_API_KEY;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * DAY) } as any });
  ids.user = me.id;
  const prop = async (address: string, apn: string | null, county: string) => (await db.property.create({ data: { userId: me.id, address, city: 'Riverside', state: 'CA', zip: '92501', county, apn, type: 'RESIDENTIAL_SINGLE' } as any })).id;
  ids.noApn = await prop('12 Sample Ct', null, 'Riverside');
  ids.withApn = await prop('1200 Elm Grove Ln', '123-456-78-00', 'Riverside');
  ids.third = await prop('45 Example Ave', null, 'Elsewhere');
});
after(async () => {
  if (skip) return;
  const queues = await import('../../src/workers/queues') as Record<string, any>;
  for (const q of Object.values(queues)) if (q && typeof q.disconnect === 'function') await Promise.resolve(q.disconnect()).catch(() => {});
  const { db } = await import('../../src/config/db');
  await db.$disconnect().catch(() => {});
  await api.stop();
});

const post = (path: string, body: unknown = {}) => fetch(`${api.url}/api/taxes${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const status = async (id: string) => ((await api.db.property.findUnique({ where: { id }, select: { taxLookupJson: true } }))!.taxLookupJson ?? null) as any;

test('with the computer offline nothing starts, and it says why', { skip }, async () => {
  const one = await post('/lookup', { propertyId: ids.withApn });
  assert.equal(one.status, 409);
  assert.equal((await one.json()).needsConnector, true);
  const all = await post('/lookup-all');
  assert.equal(all.status, 409);
  assert.match((await all.json()).error, /connector/);
  assert.equal(await status(ids.withApn), null);
});

test('look up all: the property with a parcel number goes first, the rest wait for it', { skip }, async () => {
  const r = await post('/lookup-all', { anyway: true });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.first, ids.withApn);
  assert.equal(body.waiting, 2);
  assert.equal((await status(ids.withApn)).status, 'queued');
  for (const id of [ids.noApn, ids.third]) assert.deepEqual([(await status(id)).status, (await status(id)).firstId], ['waiting', ids.withApn]);
});

test('the first one fails: the others are not started, and say why, with nothing spent', { skip }, async () => {
  const { runQueuedTaxLookup } = await import('../../src/services/taxLookupJobs');
  await runQueuedTaxLookup(ids.withApn);
  const first = await status(ids.withApn);
  assert.equal(first.status, 'failed');
  assert.equal(first.costUsd, 0);
  for (const id of [ids.noApn, ids.third]) {
    const s = await status(id);
    assert.equal(s.status, 'cancelled');
    assert.match(s.note, /first lookup .*did not work.*Nothing was spent/);
  }
});

test('the first one works: the others start', { skip }, async () => {
  const { db } = api;
  const at = new Date().toISOString();
  for (const id of [ids.noApn, ids.third]) await db.property.update({ where: { id }, data: { taxLookupJson: { status: 'waiting', at, firstId: ids.withApn } } });
  const { releaseWaiting } = await import('../../src/services/taxLookupJobs');
  await releaseWaiting(ids.withApn, true, null);
  for (const id of [ids.noApn, ids.third]) assert.equal((await status(id)).status, 'queued');
});

test('years on file are passed on: paid ones skipped, unpaid ones only checked', { skip }, async () => {
  const { db } = api;
  await db.taxAssessment.create({ data: { propertyId: ids.withApn, taxYear: '2024-25', annualTaxAmount: 4600, status: 'PAID' } as any });
  await db.taxAssessment.create({ data: { propertyId: ids.withApn, taxYear: '2025-26', annualTaxAmount: 4700, installment1Amount: 2350, installment2Amount: 2350, installment1Paid: new Date('2025-12-01') } as any });
  await db.taxDefault.create({ data: { propertyId: ids.withApn, taxYear: '2019-20', status: 'REDEEMED' } as any });
  const { onFileForLookup, onFileLines } = await import('../../src/services/propertyTaxLookup');
  const f = await onFileForLookup(ids.withApn);
  assert.deepEqual(f, { complete: ['2024-25'], open: ['2025-26'], redeemed: ['2019-20'], openDefaults: [] });
  const lines = onFileLines(f);
  assert.match(lines, /do NOT open, read or report these years again: 2024-25/);
  assert.match(lines, /check only whether each has been paid since .*: 2025-26/);
  assert.match(onFileLines({ complete: [], open: [], redeemed: [], openDefaults: [] }), /read every year/);
});
