import Stripe from 'stripe';

/**
 * The Stripe client, or null when this server has no key (a dev machine, or
 * before billing is set up). Callers say "billing isn't set up" instead of
 * failing. Keys live in Render's environment only.
 */
export const stripe: Stripe | null = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })
  : null;
