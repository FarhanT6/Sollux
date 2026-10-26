/** Plans: who may do what, and how much AI each plan includes (lib/plans.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessOf, canWrite, propertyLimit, aiAllowance, isPlatformAdmin, planForPrice } from '../../src/lib/plans';

const now = new Date('2026-10-26T12:00:00Z');
const day = 86_400_000;
const user = (o: Partial<{ subscriptionTier: string; subscriptionStatus: string | null; trialEndsAt: Date | null }>) =>
  ({ subscriptionTier: 'STARTER', subscriptionStatus: null, trialEndsAt: null, ...o });

test('a new account on its trial has Pro limits and may write', () => {
  const u = user({ trialEndsAt: new Date(now.getTime() + 5 * day) });
  assert.equal(accessOf(u, now).kind, 'trial');
  assert.equal(propertyLimit(u, now), 25);
  assert.equal(canWrite(u, now), true);
});

test('an ended trial with no plan is read-only, with no properties allowed', () => {
  const u = user({ trialEndsAt: new Date(now.getTime() - day) });
  assert.deepEqual(accessOf(u, now), { kind: 'lapsed', reason: 'trial_ended' });
  assert.equal(canWrite(u, now), false);
  assert.equal(propertyLimit(u, now), 0);
});

test('each paid plan has its own property limit', () => {
  assert.equal(propertyLimit(user({ subscriptionTier: 'STARTER', subscriptionStatus: 'active' }), now), 3);
  assert.equal(propertyLimit(user({ subscriptionTier: 'PRO', subscriptionStatus: 'active' }), now), 25);
  assert.equal(propertyLimit(user({ subscriptionTier: 'PORTFOLIO', subscriptionStatus: 'active' }), now), null);
});

test('a failed card (past_due) keeps working while Stripe retries; canceled and unpaid do not', () => {
  assert.equal(canWrite(user({ subscriptionTier: 'PRO', subscriptionStatus: 'past_due' }), now), true);
  assert.equal(canWrite(user({ subscriptionTier: 'PRO', subscriptionStatus: 'canceled' }), now), false);
  assert.equal(canWrite(user({ subscriptionTier: 'PRO', subscriptionStatus: 'unpaid' }), now), false);
});

test('accounts that predate billing (COMP) have no limits', () => {
  const u = user({ subscriptionTier: 'COMP', subscriptionStatus: 'canceled' });
  assert.equal(accessOf(u, now).kind, 'comp');
  assert.equal(propertyLimit(u, now), null);
  assert.equal(canWrite(u, now), true);
});

test('AI allowance by plan, overridable from the environment', () => {
  assert.equal(aiAllowance('STARTER'), 3);
  assert.equal(aiAllowance('PRO'), 8);
  assert.equal(aiAllowance('PORTFOLIO'), 15);
  process.env.AI_ALLOWANCE_PRO = '12';
  try { assert.equal(aiAllowance('PRO'), 12); } finally { delete process.env.AI_ALLOWANCE_PRO; }
});

test('the admin is whoever ADMIN_EMAILS names, else the pre-billing accounts', () => {
  delete process.env.ADMIN_EMAILS;
  assert.equal(isPlatformAdmin({ email: 'a@example.com', subscriptionTier: 'COMP' }), true);
  assert.equal(isPlatformAdmin({ email: 'a@example.com', subscriptionTier: 'PRO' }), false);
  process.env.ADMIN_EMAILS = 'Owner@Example.com, other@example.com';
  try {
    assert.equal(isPlatformAdmin({ email: 'owner@example.com', subscriptionTier: 'STARTER' }), true);
    assert.equal(isPlatformAdmin({ email: 'a@example.com', subscriptionTier: 'COMP' }), false);
  } finally { delete process.env.ADMIN_EMAILS; }
});

test('a Stripe price maps to its plan only when configured', () => {
  process.env.STRIPE_PRICE_PRO = 'price_pro_test';
  try {
    assert.equal(planForPrice('price_pro_test'), 'PRO');
    assert.equal(planForPrice('price_unknown'), null);
    assert.equal(planForPrice(null), null);
  } finally { delete process.env.STRIPE_PRICE_PRO; }
});
