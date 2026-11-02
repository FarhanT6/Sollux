import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromGoogleComponents, fromPhoton, stateCode } from '../../src/lib/addressParts';

test('stateCode turns names into two letters', () => {
  assert.equal(stateCode('California'), 'CA');
  assert.equal(stateCode('fl'), 'FL');
});

test('Google components become street, city, state, ZIP and county', () => {
  const p = fromGoogleComponents([
    { longText: '1200', types: ['street_number'] },
    { longText: 'Elm Grove Lane', shortText: 'Elm Grove Ln', types: ['route'] },
    { longText: '4', types: ['subpremise'] },
    { longText: 'Oceanside', types: ['locality', 'political'] },
    { longText: 'San Diego County', types: ['administrative_area_level_2'] },
    { longText: 'California', shortText: 'CA', types: ['administrative_area_level_1'] },
    { longText: '92056', types: ['postal_code'] },
  ]);
  assert.deepEqual(p, { line1: '1200 Elm Grove Ln #4', city: 'Oceanside', state: 'CA', zip: '92056', county: 'San Diego', label: '1200 Elm Grove Ln #4, Oceanside, CA 92056' });
});

test('Photon features outside the US or without a street are dropped', () => {
  assert.equal(fromPhoton({ countrycode: 'MX', street: 'Calle 1', housenumber: '5' }), null);
  assert.equal(fromPhoton({ countrycode: 'US', name: 'Some Park', type: 'house' }), null);
  const p = fromPhoton({ countrycode: 'US', housenumber: '1200', street: 'Elm Grove Lane', city: 'Oceanside', state: 'California', postcode: '92056', county: 'San Diego County' });
  assert.equal(p?.label, '1200 Elm Grove Lane, Oceanside, CA 92056');
  assert.equal(p?.county, 'San Diego');
});
