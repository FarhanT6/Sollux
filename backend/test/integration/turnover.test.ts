/** Vacancy is counted for units never let and leases ended without a date; a late first lease is not read as vacancy. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, type TestApi } from './server';

let api: TestApi;
let propertyId = '';

before(async () => {
  if (skip) return;
  api = await startApi();
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_MULTI', acquisitionDate: new Date('2020-01-01') } as any });
  propertyId = p.id;
  await db.unit.create({ data: { propertyId: p.id, unitLabel: 'A' } });
  const b = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'B' } });
  const c = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'C' } });
  await db.lease.create({ data: { unitId: b.id, rentAmount: 700, status: 'ENDED', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2023-07-01') } });
  await db.lease.create({ data: { unitId: c.id, rentAmount: 1000, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2026-07-01') } });
});
after(async () => { if (!skip) await api.stop(); });

test('never let and ended-without-a-date count as vacant; years before the first lease on record do not', { skip }, async () => {
  const r = await (await fetch(`${api.url}/api/turnover?propertyId=${propertyId}`)).json() as any;
  assert.equal(r.summary.currentlyVacant, 2);
  assert.equal(r.summary.totalRentLost, 0);
  const by = Object.fromEntries(r.units.map((u: any) => [u.unitLabel, u]));
  assert.equal(by.A.currentVacancy.neverLet, true);
  assert.equal(by.B.currentVacancy.vacatedOn, null);
  assert.equal(by.C.earlierNotOnRecord, true);
  assert.equal(by.C.sinceAcquisition, null);
});
