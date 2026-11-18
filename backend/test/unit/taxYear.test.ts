/** One tax year however it is written: a county lookup's "2026-27" and a bill's "2026-2027". */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameTaxYear } from '../../src/lib/taxLookupReport';

test('fiscal years written different ways are the same year', () => {
  for (const [a, b] of [['2026-27', '2026-2027'], ['2026/27', '2026-27'], ['FY 2026-27', '2026-2027'], ['2026', '2026']]) assert.ok(sameTaxYear(a, b), `${a} = ${b}`);
});
test('different years are not', () => {
  for (const [a, b] of [['2025-26', '2026-27'], ['2026', '2027'], ['2025-2026', '2026-2027'], ['', '2026'], ['n/a', 'n/a']]) assert.ok(!sameTaxYear(a, b), `${a} ≠ ${b}`);
});
