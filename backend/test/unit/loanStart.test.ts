import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstDueMonth, dueBy } from '../../src/lib/loanStart';

test('a loan funded July 1 is first due in August', () => {
  const l = { originationDate: new Date('2026-07-01T00:00:00Z') };
  assert.equal(firstDueMonth(l), '2026-08');
  assert.equal(dueBy(l, '2026-07'), false);
  assert.equal(dueBy(l, '2026-08'), true);
});

test('a December funding rolls into January', () => {
  assert.equal(firstDueMonth({ originationDate: new Date('2025-12-15T00:00:00Z') }), '2026-01');
});

test('a first payment date the owner gave wins', () => {
  const l = { originationDate: new Date('2026-06-15T00:00:00Z'), firstPaymentDate: new Date('2026-08-01T00:00:00Z') };
  assert.equal(firstDueMonth(l), '2026-08');
  assert.equal(dueBy(l, '2026-07'), false);
});

test('a loan with no dates is taken as running', () => {
  assert.equal(dueBy({}, '2020-01'), true);
});

test('a loan with no start date counts from the month it was added', () => {
  const l = { createdAt: new Date('2026-03-20T00:00:00Z') };
  assert.equal(firstDueMonth(l), '2026-03');
  assert.equal(dueBy(l, '2025-12'), false);
  assert.equal(dueBy(l, '2026-03'), true);
});
