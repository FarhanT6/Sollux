/**
 * The owner's plan: what they are on, what it allows, and the doors to
 * Stripe — Checkout to start or change a plan, the billing portal to update
 * a card, see invoices or cancel. Card details never touch Sollux.
 * Shared-access members see the owner's plan but only the owner can change it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { stripe } from '../config/stripe';
import { attachDbUser } from '../middleware/requireAuth';
import { PLANS, TRIAL_DAYS, accessOf, propertyLimit, type PlanKey } from '../lib/plans';

const router = Router();
router.use(attachDbUser);

const appUrl = () => (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const configured = () => !!stripe && Object.values(PLANS).every(p => !!process.env[p.envPrice]);

router.get('/', async (req, res, next) => {
  try {
    const user = await db.user.findUniqueOrThrow({ where: { id: req.dbUserId! } });
    const properties = await db.property.count({ where: { userId: user.id } });
    const access = accessOf(user);
    res.json({
      access: access.kind,
      plan: access.kind === 'active' ? access.plan : access.kind === 'comp' ? 'COMP' : null,
      status: user.subscriptionStatus,
      trialEndsAt: user.trialEndsAt,
      currentPeriodEnd: user.currentPeriodEnd,
      lapsedReason: access.kind === 'lapsed' ? access.reason : null,
      usage: { properties, propertyLimit: propertyLimit(user) },
      plans: (Object.entries(PLANS) as [PlanKey, typeof PLANS[PlanKey]][]).map(([key, p]) => ({ key, name: p.name, priceMonthly: p.priceMonthly, maxProperties: p.maxProperties, blurb: p.blurb })),
      trialDays: TRIAL_DAYS,
      billingConfigured: configured(),
      canManage: !!req.isAccountOwner,
      hasCustomer: !!user.stripeCustomerId,
    });
  } catch (err) { next(err); }
});

// Start (or switch to) a plan: a Stripe Checkout page. What is left of the
// free trial carries over, so paying early never costs trial days.
router.post('/checkout', async (req, res, next) => {
  try {
    if (!req.isAccountOwner) return res.status(403).json({ error: 'Only the account owner can change the plan.' });
    if (!stripe || !configured()) return res.status(503).json({ error: 'Billing is not set up on this server yet.' });
    const { plan } = z.object({ plan: z.enum(['STARTER', 'PRO', 'PORTFOLIO']) }).parse(req.body);
    const user = await db.user.findUniqueOrThrow({ where: { id: req.dbUserId! } });
    if (user.subscriptionTier === 'COMP') return res.status(400).json({ error: 'This account is complimentary — there is nothing to pay.' });
    // Already subscribed: changes go through the billing portal, which prorates.
    if (user.stripeSubscriptionId && user.subscriptionStatus && !['canceled', 'incomplete_expired'].includes(user.subscriptionStatus)) {
      const portal = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomerId!, return_url: `${appUrl()}/settings?tab=billing` });
      return res.json({ url: portal.url });
    }
    let customer = user.stripeCustomerId;
    if (!customer) {
      customer = (await stripe.customers.create({ email: user.email, name: user.fullName, metadata: { userId: user.id } })).id;
      await db.user.update({ where: { id: user.id }, data: { stripeCustomerId: customer } });
    }
    const trialEnd = user.trialEndsAt && user.trialEndsAt.getTime() > Date.now() + 48 * 3600_000 ? Math.floor(user.trialEndsAt.getTime() / 1000) : undefined;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: user.id,
      metadata: { userId: user.id },
      line_items: [{ price: process.env[PLANS[plan].envPrice]!, quantity: 1 }],
      subscription_data: trialEnd ? { trial_end: trialEnd, metadata: { userId: user.id } } : { metadata: { userId: user.id } },
      allow_promotion_codes: true,
      success_url: `${appUrl()}/settings?tab=billing&checkout=success`,
      cancel_url: `${appUrl()}/settings?tab=billing`,
    });
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// Update the card, see invoices, change or cancel the plan: Stripe's portal.
router.post('/portal', async (req, res, next) => {
  try {
    if (!req.isAccountOwner) return res.status(403).json({ error: 'Only the account owner can manage billing.' });
    if (!stripe) return res.status(503).json({ error: 'Billing is not set up on this server yet.' });
    const user = await db.user.findUniqueOrThrow({ where: { id: req.dbUserId! } });
    if (!user.stripeCustomerId) return res.status(400).json({ error: 'Choose a plan first.' });
    const portal = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: `${appUrl()}/settings?tab=billing` });
    res.json({ url: portal.url });
  } catch (err) { next(err); }
});

export default router;
