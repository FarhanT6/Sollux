/**
 * A tax bill saved for a year already on file under another spelling (a county lookup wrote
 * "2026-27", the bill reads "2026-2027") updates that year instead of adding a second one,
 * which showed the year twice and counted it twice. Made-up property and amounts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, type TestApi } from './server';

let api: TestApi;
let propertyId = '';
before(async () => {
  if (skip) return;
  api = await startApi();
  const me = await api.db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } as any });
  propertyId = (await api.db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } as any })).id;
  await api.db.taxAssessment.create({ data: { propertyId, taxYear: '2026-27', annualTaxAmount: 4800, installment1Amount: 2400, sourceUrl: 'https://example.org/parcel' } as any });
});
after(async () => { if (!skip) await api.stop(); });

const post = (body: unknown) => fetch(`${api.url}/api/taxes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a bill for "2026-2027" updates the "2026-27" year a lookup saved', { skip }, async () => {
  const r = await post({ propertyId, taxYear: '2026-2027', annualTaxAmount: 4812.5, installment1Amount: 2406.25, installment2Amount: 2406.25, billNumber: 'B-1001' });
  assert.equal(r.status, 201, await r.text());
  const rows = await api.db.taxAssessment.findMany({ where: { propertyId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taxYear, '2026-27');
  assert.equal(Number(rows[0].annualTaxAmount), 4812.5);
  assert.equal(rows[0].billNumber, 'B-1001');
});

test('another year is still its own record', { skip }, async () => {
  const r = await post({ propertyId, taxYear: '2025-2026', annualTaxAmount: 4700 });
  assert.equal(r.status, 201, await r.text());
  assert.equal(await api.db.taxAssessment.count({ where: { propertyId } }), 2);
});
