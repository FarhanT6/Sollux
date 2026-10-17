/**
 * Rent collected online: tenants pay from the tenant portal through Stripe,
 * and the money is paid out to the owner's own Stripe (Connect Express)
 * account. Sollux takes nothing for itself.
 *
 *   Bank (ACH)  free to the tenant; Stripe's 0.8% (at most $5) comes out of
 *               what the owner receives.
 *   Card        the tenant pays Stripe's 2.9% + 30¢ on top, so the owner
 *               receives the rent in full.
 *
 * The charge is made on the platform and passed through to the owner's
 * account (a destination charge). The platform's application fee is exactly
 * Stripe's processing fee, so the platform nets nothing either way.
 *
 * A payment lands in the rent ledger like any other (recordRentPayment): a
 * card payment as received at once; a bank payment as pending until it
 * clears (2–4 business days), then received — and removed if it fails.
 */
import type Stripe from 'stripe';
import { db } from '../config/db';
import { stripe } from '../config/stripe';
import { monthRentDue } from '../lib/rentDue';
import { chargesFor, creditedTo, recordRentPayment } from './rentPaymentService';
import { emailConfigured, sendAlertEmail } from './notificationService';

export type PayMethod = 'card' | 'us_bank_account';
const round2 = (n: number) => Math.round(n * 100) / 100;
const cents = (n: number) => Math.round(n * 100);

/** What the tenant is charged, what the owner receives, and the fee between. */
export function feesFor(rent: number, method: PayMethod): { charge: number; tenantFee: number; ownerReceives: number; stripeFee: number } {
  if (method === 'card') {
    // Grossed up so that after 2.9% + 30¢ the rent is left whole.
    const charge = round2((rent + 0.3) / (1 - 0.029));
    return { charge, tenantFee: round2(charge - rent), ownerReceives: rent, stripeFee: round2(charge - rent) };
  }
  const stripeFee = Math.min(5, round2(rent * 0.008));
  return { charge: rent, tenantFee: 0, ownerReceives: round2(rent - stripeFee), stripeFee };
}

const periodOf = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

/** What a lease owes now: this month's rent and charges not yet paid, and the earlier balance. */
export async function leaseBalance(leaseId: string, now = new Date()): Promise<{ periodDate: Date; thisMonth: number; arrears: number; total: number; pending: number }> {
  const periodDate = periodOf(now);
  const lease = await db.lease.findUnique({
    where: { id: leaseId },
    select: { rentAmount: true, section8Amount: true, arrearsBalance: true, arrearsCaughtUpThrough: true, startDate: true, firstMonthRent: true },
  });
  if (!lease) return { periodDate, thisMonth: 0, arrears: 0, total: 0, pending: 0 };
  // The housing authority's share is paid by the authority, not the tenant.
  const rent = Math.max(0, monthRentDue(lease, periodDate) - Number(lease.section8Amount ?? 0));
  const thisMonth = Math.max(0, round2(rent + await chargesFor(leaseId, periodDate) - await creditedTo(leaseId, periodDate)));
  const arrears = Math.max(0, round2(Number(lease.arrearsBalance)));
  const pendingRows = await db.rentPayment.findMany({ where: { leaseId, status: 'PENDING' }, select: { amount: true } });
  const pending = round2(pendingRows.reduce((s, p) => s + Number(p.amount), 0));
  return { periodDate, thisMonth, arrears, total: round2(thisMonth + arrears), pending };
}

// ─── The owner's Stripe account ────────────────────────────

export interface ConnectStatus { configured: boolean; connected: boolean; chargesEnabled: boolean; payoutsEnabled: boolean; needsInfo: boolean }

/** Where the owner's Stripe account stands, refreshed from Stripe. */
export async function connectStatus(userId: string): Promise<ConnectStatus> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { stripeConnectId: true, connectChargesEnabled: true, connectPayoutsEnabled: true } });
  if (!stripe) return { configured: false, connected: false, chargesEnabled: false, payoutsEnabled: false, needsInfo: false };
  if (!u?.stripeConnectId) return { configured: true, connected: false, chargesEnabled: false, payoutsEnabled: false, needsInfo: false };
  const a = await stripe.accounts.retrieve(u.stripeConnectId);
  const chargesEnabled = !!a.charges_enabled, payoutsEnabled = !!a.payouts_enabled;
  if (chargesEnabled !== u.connectChargesEnabled || payoutsEnabled !== u.connectPayoutsEnabled) {
    await db.user.update({ where: { id: userId }, data: { connectChargesEnabled: chargesEnabled, connectPayoutsEnabled: payoutsEnabled } });
  }
  return { configured: true, connected: true, chargesEnabled, payoutsEnabled, needsInfo: (a.requirements?.currently_due?.length ?? 0) > 0 };
}

/** Stripe's own onboarding page for the owner's account (created on first use). */
export async function connectOnboardingUrl(userId: string): Promise<string> {
  if (!stripe) throw new Error('Stripe is not set up on this server yet.');
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, stripeConnectId: true } });
  let accountId = u.stripeConnectId;
  if (!accountId) {
    const a = await stripe.accounts.create({
      type: 'express', email: u.email, country: 'US',
      capabilities: { card_payments: { requested: true }, transfers: { requested: true }, us_bank_account_ach_payments: { requested: true } },
      business_profile: { mcc: '6513', product_description: 'Residential and commercial rent' },
      metadata: { userId },
    });
    accountId = a.id;
    await db.user.update({ where: { id: userId }, data: { stripeConnectId: accountId } });
  }
  const back = `${process.env.FRONTEND_URL}/settings?tab=rent`;
  const link = await stripe.accountLinks.create({ account: accountId, type: 'account_onboarding', refresh_url: back, return_url: `${back}&connected=1` });
  return link.url;
}

/** The owner's Stripe Express dashboard: payouts, balances, bank details. */
export async function connectDashboardUrl(userId: string): Promise<string> {
  if (!stripe) throw new Error('Stripe is not set up on this server yet.');
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { stripeConnectId: true } });
  if (!u.stripeConnectId) throw new Error('Connect a Stripe account first.');
  return (await stripe.accounts.createLoginLink(u.stripeConnectId)).url;
}

// ─── Paying ────────────────────────────────────────────────

type Access = { id: string; tenantId: string; ownerUserId: string; email: string | null; stripeCustomerId: string | null };

async function customerFor(access: Access): Promise<string> {
  if (access.stripeCustomerId) return access.stripeCustomerId;
  const t = await db.tenant.findUnique({ where: { id: access.tenantId }, select: { fullName: true, email: true } });
  const c = await stripe!.customers.create({ name: t?.fullName, email: t?.email ?? access.email ?? undefined, metadata: { tenantId: access.tenantId, portalAccessId: access.id } });
  await db.tenantPortalAccess.update({ where: { id: access.id }, data: { stripeCustomerId: c.id } });
  return c.id;
}

async function ownerAccount(ownerUserId: string): Promise<string> {
  const u = await db.user.findUnique({ where: { id: ownerUserId }, select: { stripeConnectId: true, connectChargesEnabled: true } });
  if (!u?.stripeConnectId || !u.connectChargesEnabled) throw new Error('Your landlord has not turned on online rent payments yet.');
  return u.stripeConnectId;
}

/** A Stripe Checkout page for one rent payment. */
export async function rentCheckoutUrl(access: Access, leaseId: string, amount: number, method: PayMethod): Promise<string> {
  if (!stripe) throw new Error('Online payments are not set up yet.');
  if (!(amount >= 1)) throw new Error('Enter an amount of at least $1.');
  const destination = await ownerAccount(access.ownerUserId);
  const f = feesFor(round2(amount), method);
  const lease = await db.lease.findUnique({ where: { id: leaseId }, select: { unit: { select: { unitLabel: true, property: { select: { address: true } } } } } });
  const what = `Rent · ${lease?.unit.property.address ?? ''}${lease?.unit.unitLabel ? ` ${lease.unit.unitLabel}` : ''}`;
  const periodDate = periodOf();
  const metadata = { kind: 'rent', leaseId, accessId: access.id, periodDate: periodDate.toISOString(), rent: String(round2(amount)), tenantFee: String(f.tenantFee) };
  const s = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: await customerFor(access),
    payment_method_types: [method],
    line_items: [
      { quantity: 1, price_data: { currency: 'usd', unit_amount: cents(amount), product_data: { name: what } } },
      ...(f.tenantFee > 0 ? [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents(f.tenantFee), product_data: { name: 'Card processing fee (bank payments are free)' } } }] : []),
    ],
    payment_intent_data: {
      application_fee_amount: cents(f.stripeFee),
      on_behalf_of: destination,
      transfer_data: { destination },
      metadata,
      description: what,
    },
    ...(method === 'us_bank_account' ? { payment_method_options: { us_bank_account: { verification_method: 'automatic' } } } : {}),
    metadata,
    success_url: `${process.env.FRONTEND_URL}/portal?paid=1`,
    cancel_url: `${process.env.FRONTEND_URL}/portal`,
  });
  return s.url!;
}

/** A Stripe Checkout page that saves a card or bank account for autopay. */
export async function autopaySetupUrl(access: Access, method: PayMethod): Promise<string> {
  if (!stripe) throw new Error('Online payments are not set up yet.');
  await ownerAccount(access.ownerUserId);
  const s = await stripe.checkout.sessions.create({
    mode: 'setup', currency: 'usd',
    customer: await customerFor(access),
    payment_method_types: [method],
    metadata: { kind: 'autopay', accessId: access.id },
    setup_intent_data: { metadata: { kind: 'autopay', accessId: access.id } },
    success_url: `${process.env.FRONTEND_URL}/portal?autopay=1`,
    cancel_url: `${process.env.FRONTEND_URL}/portal`,
  });
  return s.url!;
}

function labelOf(pm: Stripe.PaymentMethod): string {
  if (pm.card) return `${pm.card.brand[0].toUpperCase()}${pm.card.brand.slice(1)} ··${pm.card.last4}`;
  if (pm.us_bank_account) return `${pm.us_bank_account.bank_name ?? 'Bank'} ··${pm.us_bank_account.last4}`;
  return pm.type;
}

/**
 * Autopay: on the due day, charge each enrolled tenant what the month still
 * owes (never the earlier balance — that stays the tenant's choice), once.
 */
export async function runAutopay(now = new Date()): Promise<{ charged: number; skipped: number }> {
  if (!stripe) return { charged: 0, skipped: 0 };
  const enrolled = await db.tenantPortalAccess.findMany({ where: { autopay: true, disabled: false, autopayMethodId: { not: null } } });
  let charged = 0, skipped = 0;
  for (const a of enrolled) {
    const leases = await db.lease.findMany({ where: { status: 'ACTIVE', leaseTenants: { some: { tenantId: a.tenantId } } }, select: { id: true, rentDueDay: true } });
    for (const l of leases) {
      if (now.getUTCDate() < Math.min(l.rentDueDay ?? 1, 28)) { skipped++; continue; }
      const b = await leaseBalance(l.id, now);
      if (b.thisMonth < 1 || b.pending > 0) { skipped++; continue; }
      const method = (a.autopayMethodType === 'card' ? 'card' : 'us_bank_account') as PayMethod;
      try {
        const destination = await ownerAccount(a.ownerUserId);
        const f = feesFor(b.thisMonth, method);
        const metadata = { kind: 'rent', autopay: '1', leaseId: l.id, accessId: a.id, periodDate: b.periodDate.toISOString(), rent: String(b.thisMonth), tenantFee: String(f.tenantFee) };
        const pi = await stripe.paymentIntents.create({
          amount: cents(f.charge), currency: 'usd', customer: a.stripeCustomerId!, payment_method: a.autopayMethodId!,
          payment_method_types: [method], off_session: true, confirm: true,
          application_fee_amount: cents(f.stripeFee), on_behalf_of: destination, transfer_data: { destination },
          metadata, description: 'Rent (autopay)',
        }, { idempotencyKey: `autopay-${l.id}-${b.periodDate.toISOString().slice(0, 7)}` });
        await applyPaymentIntent(pi);
        charged++;
      } catch (err) {
        console.warn(`[Autopay] lease ${l.id}:`, err instanceof Error ? err.message : err);
        skipped++;
      }
    }
  }
  return { charged, skipped };
}

/**
 * Bring a rent payment in the ledger in line with its Stripe payment:
 * processing → pending, succeeded → received, failed or cancelled → removed.
 */
export async function applyPaymentIntent(pi: Stripe.PaymentIntent): Promise<void> {
  const m = pi.metadata ?? {};
  if (m.kind !== 'rent' || !m.leaseId) return;
  const existing = await db.rentPayment.findUnique({ where: { stripePaymentIntentId: pi.id } });
  const rent = Number(m.rent ?? pi.amount / 100);
  const method = pi.payment_method_types.includes('card') ? 'CARD' : 'ACH';

  if (pi.status === 'canceled' || pi.status === 'requires_payment_method') {
    // A bank payment that bounced: it never paid anything.
    if (existing) await removePayment(existing);
    if (pi.last_payment_error) await tellOwner(m.leaseId, `An online rent payment of $${rent.toFixed(2)} failed`, [pi.last_payment_error.message ?? 'The payment was declined.']);
    return;
  }
  if (pi.status !== 'processing' && pi.status !== 'succeeded') return;
  const status = pi.status === 'succeeded' ? 'RECEIVED' : 'PENDING';
  if (existing?.status === status) return;
  if (existing) await removePayment(existing); // re-recorded so arrears are applied on arrival
  const p = await recordRentPayment({
    leaseId: m.leaseId, periodDate: new Date(m.periodDate ?? periodOf().toISOString()), amount: rent,
    paidDate: new Date(), method, status,
    expectedDate: status === 'PENDING' ? new Date(Date.now() + 4 * 86_400_000) : undefined,
    notes: `Paid online${m.autopay ? ' (autopay)' : ''} through the tenant portal`,
  });
  await db.rentPayment.update({ where: { id: p.id }, data: { stripePaymentIntentId: pi.id, tenantFee: Number(m.tenantFee ?? 0) || null } });
  if (status === 'RECEIVED') await tellOwner(m.leaseId, `Rent received online: $${rent.toFixed(2)}`, [method === 'CARD' ? 'Paid by card (the tenant paid the card fee).' : 'Paid by bank transfer.'], false);
}

/** Take a payment out of the ledger, putting back what it knocked off the earlier balance. */
async function removePayment(p: { id: string; leaseId: string; appliedToArrears: unknown }) {
  await db.rentPayment.delete({ where: { id: p.id } });
  const restored = Number(p.appliedToArrears);
  if (restored > 0) await db.lease.update({ where: { id: p.leaseId }, data: { arrearsBalance: { increment: restored } } });
}

async function tellOwner(leaseId: string, headline: string, lines: string[], urgent = true) {
  const l = await db.lease.findUnique({ where: { id: leaseId }, select: { unit: { select: { unitLabel: true, property: { select: { address: true, user: { select: { email: true } } } } } }, leaseTenants: { take: 1, include: { tenant: { select: { fullName: true } } } } } });
  if (!l || !emailConfigured()) return;
  const who = l.leaseTenants[0]?.tenant.fullName ?? 'A tenant';
  await sendAlertEmail({ to: l.unit.property.user.email, subject: headline, headline: urgent ? headline : `${headline}`, lines: [`${who} · ${l.unit.property.address}${l.unit.unitLabel ? ` ${l.unit.unitLabel}` : ''}`, ...lines], path: `/payments` }).catch(() => {});
}

/** Rent-collection events from the Stripe webhook (routes/stripe.ts). */
export async function handleRentEvent(event: Stripe.Event): Promise<boolean> {
  if (!stripe) return false;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed': {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.metadata?.kind === 'rent' && s.payment_intent) {
        await applyPaymentIntent(await stripe.paymentIntents.retrieve(String(s.payment_intent)));
        return true;
      }
      if (s.metadata?.kind === 'autopay' && s.setup_intent) {
        const si = await stripe.setupIntents.retrieve(String(s.setup_intent), { expand: ['payment_method'] });
        const pm = si.payment_method as Stripe.PaymentMethod | null;
        if (pm) await db.tenantPortalAccess.update({ where: { id: s.metadata.accessId }, data: { autopay: true, autopayMethodId: pm.id, autopayMethodType: pm.type, autopayLabel: labelOf(pm) } });
        return true;
      }
      return false;
    }
    case 'payment_intent.processing':
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent;
      if (pi.metadata?.kind !== 'rent') return false;
      await applyPaymentIntent(pi);
      return true;
    }
    case 'account.updated': {
      const a = event.data.object as Stripe.Account;
      await db.user.updateMany({ where: { stripeConnectId: a.id }, data: { connectChargesEnabled: !!a.charges_enabled, connectPayoutsEnabled: !!a.payouts_enabled } });
      return true;
    }
    default:
      return false;
  }
}
