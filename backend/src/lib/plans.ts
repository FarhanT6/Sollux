/**
 * Sollux plans: what each costs and allows, and whether an account may make
 * changes right now. One place, read by the billing routes, the limits on
 * creating properties, and the write guard.
 *
 *   Starter    $19/mo   up to 3 properties
 *   Pro        $49/mo   up to 25 properties
 *   Portfolio  $99/mo   unlimited
 *   Comp       free     accounts that predate billing; no limits
 *
 * Every plan includes everything else (utility intelligence, rent
 * collection, the tenant portal). New accounts start with a 14-day free
 * trial with Pro's limits, so the trial shows the whole product.
 */
export type PlanKey = 'STARTER' | 'PRO' | 'PORTFOLIO';

export const PLANS: Record<PlanKey, { name: string; priceMonthly: number; maxProperties: number | null; envPrice: string; blurb: string }> = {
  STARTER:   { name: 'Starter',   priceMonthly: 19, maxProperties: 3,    envPrice: 'STRIPE_PRICE_STARTER',   blurb: 'Up to 3 properties' },
  PRO:       { name: 'Pro',       priceMonthly: 49, maxProperties: 25,   envPrice: 'STRIPE_PRICE_PRO',       blurb: 'Up to 25 properties' },
  PORTFOLIO: { name: 'Portfolio', priceMonthly: 99, maxProperties: null, envPrice: 'STRIPE_PRICE_PORTFOLIO', blurb: 'Unlimited properties' },
};

export const TRIAL_DAYS = 14;

/**
 * What each plan may spend on Claude a month (bill reading, portal fetches,
 * insights), in dollars. One heavy account runs out of its own allowance
 * instead of using up the app's budget for everyone. Override on Render
 * with AI_ALLOWANCE_STARTER / _PRO / _PORTFOLIO. The trial gets Pro's.
 */
const AI_ALLOWANCE_DEFAULT: Record<PlanKey, number> = { STARTER: 3, PRO: 8, PORTFOLIO: 15 };
export function aiAllowance(plan: PlanKey): number {
  const v = Number(process.env[`AI_ALLOWANCE_${plan}`]);
  return Number.isFinite(v) && v >= 0 && process.env[`AI_ALLOWANCE_${plan}`]?.trim() ? v : AI_ALLOWANCE_DEFAULT[plan];
}

/**
 * The person who runs Sollux (you), not a customer: sees app-wide figures
 * such as every account's AI spend, and has no per-account AI allowance.
 * ADMIN_EMAILS on Render (comma-separated); when it is not set, the
 * accounts that predate billing (COMP) are the admins.
 */
export function isPlatformAdmin(u: { email: string; subscriptionTier: string }): boolean {
  const list = (process.env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list.includes(u.email.toLowerCase()) : u.subscriptionTier === 'COMP';
}
/** During the trial: Pro's limits, so the trial shows the product. */
const TRIAL_MAX_PROPERTIES = PLANS.PRO.maxProperties;

export interface BillingUser {
  subscriptionTier: string;
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
  currentPeriodEnd?: Date | null;
}

export type Access =
  | { kind: 'comp' }
  | { kind: 'trial'; endsAt: Date }
  | { kind: 'active'; plan: PlanKey; status: string }
  | { kind: 'lapsed'; reason: 'trial_ended' | 'past_due' | 'canceled' | 'unpaid' };

export function accessOf(u: BillingUser, now = new Date()): Access {
  if (u.subscriptionTier === 'COMP') return { kind: 'comp' };
  const status = u.subscriptionStatus;
  // Stripe's own states. past_due keeps working while Stripe retries the card.
  if (status === 'active' || status === 'trialing' || status === 'past_due') {
    return { kind: 'active', plan: planKeyOf(u.subscriptionTier), status };
  }
  if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
    return { kind: 'lapsed', reason: status === 'canceled' ? 'canceled' : 'unpaid' };
  }
  // Not been to checkout: the free trial.
  if (u.trialEndsAt && u.trialEndsAt > now) return { kind: 'trial', endsAt: u.trialEndsAt };
  return { kind: 'lapsed', reason: 'trial_ended' };
}

export function planKeyOf(tier: string): PlanKey {
  return tier === 'PRO' || tier === 'PORTFOLIO' ? tier : 'STARTER';
}

/** How many properties the account may have; null is unlimited. */
export function propertyLimit(u: BillingUser, now = new Date()): number | null {
  const a = accessOf(u, now);
  if (a.kind === 'comp') return null;
  if (a.kind === 'trial') return TRIAL_MAX_PROPERTIES;
  if (a.kind === 'active') return PLANS[a.plan].maxProperties;
  return 0;
}

/** Whether the account may change anything (reading is always allowed). */
export function canWrite(u: BillingUser, now = new Date()): boolean {
  return accessOf(u, now).kind !== 'lapsed';
}

/** The plan a Stripe price id stands for, from the env-configured prices. */
export function planForPrice(priceId: string | null | undefined): PlanKey | null {
  if (!priceId) return null;
  for (const [k, p] of Object.entries(PLANS) as [PlanKey, typeof PLANS[PlanKey]][]) {
    if (process.env[p.envPrice] === priceId) return k;
  }
  return null;
}
