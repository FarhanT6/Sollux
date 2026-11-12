/** Where the database is, read from its address: the region only, never the address or its password. Made-up hosts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databasePlace } from '../../src/routes/speed';

test('the database region from its address, without the address itself', () => {
  assert.deepEqual(databasePlace('postgresql://u:secret@ep-quiet-sample-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require'), { region: 'AWS us-east-2', pooled: true, provider: 'Neon' });
  assert.deepEqual(databasePlace('postgresql://u:secret@ep-quiet-sample-123456.us-west-2.aws.neon.tech/neondb'), { region: 'AWS us-west-2', pooled: false, provider: 'Neon' });
  assert.deepEqual(databasePlace('postgresql://u:secret@dpg-sample123-a.oregon-postgres.render.com/sollux'), { region: 'oregon', pooled: false, provider: 'Render Postgres' });
  assert.equal(databasePlace('postgresql://postgres@localhost:5432/sollux').provider, 'local');
  assert.deepEqual(databasePlace(undefined), { region: null, pooled: false, provider: null });
  assert.ok(!JSON.stringify(databasePlace('postgresql://u:secret@ep-x.us-east-2.aws.neon.tech/db')).includes('secret'));
});
