/**
 * Billing: a lapsed plan is read-only, plan limits hold, and Stripe's signed
 * webhooks move the account between plans. Events are signed with a test
 * secret; nothing is sent to Stripe.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { startApi, skip, OWNER, type TestApi } from './server';

const WHSEC = 'whsec_test_secret';
let api: TestApi;
let meId = '';

before(async () => {
  if (skip) return;
  api = await startApi({ STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_PORTFOLIO: 'price_portfolio' });
  const me = await api.db.user.create({ data: { ...OWNER, stripeCustomerId: 'cus_test', trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  meId = me.id;
});
after(async () => { if (!skip) await api.stop(); });

const newProperty = () => fetch(`${api.url}/api/properties`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ address: `${Math.floor(Math.random() * 9000) + 100} Test Ave`, city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' }),
});
const setUser = (data: any) => api.db.user.update({ where: { id: meId }, data });

function webhook(event: unknown, secret = WHSEC) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return fetch(`${api.url}/api/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
}
const subscriptionEvent = (type: string, status: string, price: string) => ({
  id: 'evt_test', object: 'event', type,
  data: { object: { id: 'sub_test', object: 'subscription', customer: 'cus_test', status, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, items: { data: [{ price: { id: price } }] } } },
});

test('an ended trial is read-only: adding a property is refused, reading still works', { skip }, async () => {
  await setUser({ trialEndsAt: new Date(Date.now() - 86_400_000), subscriptionStatus: null });
  const r = await newProperty();
  assert.equal(r.status, 402);
  assert.equal((await r.json() as any).code, 'PLAN_REQUIRED');
  assert.equal((await fetch(`${api.url}/api/properties`)).status, 200);
});

test('Starter allows 3 properties and refuses the 4th', { skip }, async () => {
  await setUser({ subscriptionTier: 'STARTER', subscriptionStatus: 'active' });
  await api.db.property.deleteMany({ where: { userId: meId } });
  for (let i = 0; i < 3; i++) assert.equal((await newProperty()).status, 201);
  const r = await newProperty();
  assert.equal(r.status, 402);
  assert.equal((await r.json() as any).code, 'PLAN_LIMIT');
});

test('an unsigned or wrongly signed webhook is refused', { skip }, async () => {
  assert.equal((await webhook(subscriptionEvent('customer.subscription.updated', 'active', 'price_portfolio'), 'whsec_wrong')).status, 400);
  assert.equal((await api.db.user.findUnique({ where: { id: meId } }))?.subscriptionTier, 'STARTER');
});

test('an upgrade from Stripe moves the account to Portfolio, with no property limit', { skip }, async () => {
  assert.equal((await webhook(subscriptionEvent('customer.subscription.updated', 'active', 'price_portfolio'))).status, 200);
  const u = await api.db.user.findUnique({ where: { id: meId } });
  assert.equal(u?.subscriptionTier, 'PORTFOLIO');
  assert.equal(u?.subscriptionStatus, 'active');
  assert.equal((await newProperty()).status, 201);
});

test('a cancellation from Stripe makes the account read-only', { skip }, async () => {
  assert.equal((await webhook(subscriptionEvent('customer.subscription.deleted', 'canceled', 'price_portfolio'))).status, 200);
  assert.equal((await api.db.user.findUnique({ where: { id: meId } }))?.subscriptionStatus, 'canceled');
  assert.equal((await newProperty()).status, 402);
});
