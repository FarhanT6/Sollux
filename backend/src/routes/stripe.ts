/**
 * Stripe's webhook: subscription changes land on the account here — a
 * checkout completed, a renewal, a failed card, a cancellation. Mounted
 * before sign-in (Stripe is not a user) with the raw body, which the
 * signature check needs (index.ts). Anything unsigned is refused.
 */
import { Router } from 'express';
import type Stripe from 'stripe';
import { stripe } from '../config/stripe';
import { db } from '../config/db';
import { planForPrice } from '../lib/plans';

const router = Router();

router.post('/webhook', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(503).json({ error: 'Billing is not set up on this server.' });
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, String(req.headers['stripe-signature'] ?? ''), secret);
  } catch {
    return res.status(400).json({ error: 'Bad signature' });
  }
  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe] webhook failed:', event.type, err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Webhook handling failed' }); // Stripe retries
  }
});

/** Apply one Stripe event to the account it belongs to. Exported for tests. */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.mode !== 'subscription' || !s.subscription || !s.customer) return;
      const userId = s.client_reference_id ?? s.metadata?.userId;
      if (userId) await db.user.updateMany({ where: { id: userId }, data: { stripeCustomerId: String(s.customer) } });
      if (stripe) await applySubscription(await stripe.subscriptions.retrieve(String(s.subscription)));
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(event.data.object as Stripe.Subscription);
      return;
    default:
      return;
  }
}

/** The account's plan and status, as Stripe has them. */
export async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const plan = planForPrice(sub.items.data[0]?.price?.id);
  await db.user.updateMany({
    where: { stripeCustomerId: customer, subscriptionTier: { not: 'COMP' } },
    data: {
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
      ...(plan ? { subscriptionTier: plan } : {}),
    },
  });
}

export default router;
