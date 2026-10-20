/**
 * The owner's side of online rent: connecting their Stripe account (where
 * tenants' rent is paid out), and inviting tenants to the tenant portal.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { connectStatus, connectOnboardingUrl, connectDashboardUrl, feesFor } from '../services/rentCollection';
import { emailConfigured, sendAlertEmail } from '../services/notificationService';

const router = Router();
router.use(attachDbUser);

const INVITE_DAYS = 14;

/**
 * What the tenant portal needs before tenants use it, each checked live: the
 * Stripe keys and webhooks on the server, the owner's payout account, a
 * production sign-in for tenants, email for invites, and the app address
 * that invite links point to. Secrets are only checked for being set — never
 * returned.
 */
function setupChecklist(status: { configured: boolean; connected: boolean; chargesEnabled: boolean; payoutsEnabled: boolean; needsInfo: boolean }) {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  const live = key.startsWith('sk_live_') || key.startsWith('rk_live_');
  const clerk = process.env.CLERK_SECRET_KEY ?? '';
  const front = process.env.FRONTEND_URL ?? '';
  return [
    { key: 'stripe', label: 'Stripe keys on the server', ok: !!key, detail: !key ? 'Add STRIPE_SECRET_KEY on Render (API and workers).' : live ? 'Live keys — real payments.' : 'Test keys — payments are pretend. Switch to live keys before tenants pay.' },
    { key: 'webhook', label: 'Stripe payments webhook', ok: !!process.env.STRIPE_WEBHOOK_SECRET, detail: process.env.STRIPE_WEBHOOK_SECRET ? 'Set — rent payments land in the ledger.' : 'Add a webhook to /api/stripe/webhook (checkout.session.*, payment_intent.*, customer.subscription.*) and put its secret in STRIPE_WEBHOOK_SECRET.' },
    { key: 'connectWebhook', label: 'Stripe Connect webhook', ok: !!process.env.STRIPE_CONNECT_WEBHOOK_SECRET, detail: process.env.STRIPE_CONNECT_WEBHOOK_SECRET ? 'Set — your payout account status stays current.' : 'Add a "connected accounts" webhook to the same URL (account.updated) and put its secret in STRIPE_CONNECT_WEBHOOK_SECRET.' },
    { key: 'payouts', label: 'Your payout account', ok: status.connected && status.chargesEnabled && status.payoutsEnabled, detail: !status.configured ? 'Needs the Stripe keys first.' : !status.connected ? 'Press Connect with Stripe above.' : !status.chargesEnabled || status.needsInfo ? 'Stripe needs a few more details — Finish setup on Stripe.' : !status.payoutsEnabled ? 'Tenants can pay; payouts start once Stripe verifies your bank.' : 'Active — rent is paid out to your bank.' },
    { key: 'signin', label: 'Tenant sign-in (Clerk)', ok: clerk.startsWith('sk_live_'), detail: clerk.startsWith('sk_live_') ? 'Production — tenants sign in normally.' : 'Development instance — tenants see a "development mode" banner and sign-ups are limited. Create the production instance in Clerk and swap the keys on Render and Vercel.' },
    { key: 'email', label: 'Invite emails', ok: emailConfigured(), detail: emailConfigured() ? 'Invites are emailed to tenants.' : 'Email is not set up (SendGrid on Render). Invites still work: copy each link and text it.' },
    { key: 'link', label: 'Invite link address', ok: /^https:\/\//.test(front), detail: /^https:\/\//.test(front) ? `Invites open ${front}/portal/join.` : 'Set FRONTEND_URL on Render to the app\'s https address, or invite links will not open.' },
  ];
}

/** A one-time join link for one tenant, emailed when email is set up; returns the link to copy too. */
async function inviteTenant(ownerUserId: string, t: { id: string; fullName: string; email: string | null }, emailIn: string | null, resetSignIn = false): Promise<{ link: string; emailed: boolean; email: string | null }> {
  const email = emailIn || t.email || null;
  const token = randomBytes(24).toString('base64url');
  const existing = await db.tenantPortalAccess.findUnique({ where: { tenantId: t.id } });
  // A tenant who already joined keeps their sign-in; a new link is for a new device or person only when asked.
  const data = { email, inviteToken: token, inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000), invitedAt: new Date(), disabled: false };
  if (existing) await db.tenantPortalAccess.update({ where: { id: existing.id }, data: resetSignIn ? { ...data, clerkUserId: null, acceptedAt: null } : data });
  else await db.tenantPortalAccess.create({ data: { tenantId: t.id, ownerUserId, ...data } });
  const link = `${process.env.FRONTEND_URL}/portal/join?token=${token}`;
  let emailed = false;
  if (email && emailConfigured()) {
    const owner = await db.user.findUnique({ where: { id: ownerUserId }, select: { fullName: true } });
    await sendAlertEmail({
      to: email, subject: `${owner?.fullName ?? 'Your landlord'} invited you to pay rent and request repairs online`,
      headline: `Your tenant portal is ready`,
      lines: [`Hi ${t.fullName.split(/\s+/)[0]},`, `${owner?.fullName ?? 'Your landlord'} uses Sollux. In your portal you can pay rent by bank transfer (free) or card, set up autopay, and send repair requests with photos.`, `The link below works for ${INVITE_DAYS} days.`],
      path: `/portal/join?token=${token}`,
    }).then(() => { emailed = true; }).catch(err => console.warn('[Portal] invite email failed:', err instanceof Error ? err.message : err));
  }
  return { link, emailed, email };
}

/** Tenants on an active lease who are not on the portal yet (never invited, or turned off). */
async function notYetInvited(userId: string) {
  const tenants = await db.tenant.findMany({
    where: { userId, leaseTenants: { some: { lease: { status: 'ACTIVE' } } } },
    select: { id: true, fullName: true, email: true, leaseTenants: { where: { lease: { status: 'ACTIVE' } }, take: 1, select: { lease: { select: { unit: { select: { unitLabel: true, property: { select: { nickname: true, address: true } } } } } } } } },
    orderBy: { fullName: 'asc' },
  });
  const access = await db.tenantPortalAccess.findMany({ where: { tenantId: { in: tenants.map(t => t.id) } }, select: { tenantId: true, disabled: true } });
  const on = new Set(access.filter(a => !a.disabled).map(a => a.tenantId));
  return tenants.filter(t => !on.has(t.id)).map(t => {
    const u = t.leaseTenants[0]?.lease.unit;
    return { id: t.id, fullName: t.fullName, email: t.email, place: u ? `${u.property.nickname || u.property.address}${u.unitLabel ? ` · ${u.unitLabel}` : ''}` : '' };
  });
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.dbUserId!;
    const [status, access] = await Promise.all([
      connectStatus(userId).catch(err => ({ configured: true, connected: false, chargesEnabled: false, payoutsEnabled: false, needsInfo: false, error: err instanceof Error ? err.message : String(err) })),
      db.tenantPortalAccess.findMany({ where: { ownerUserId: userId }, select: { tenantId: true, acceptedAt: true, autopay: true, disabled: true } }),
    ]);
    res.json({
      ...status,
      canManage: !!req.isAccountOwner,
      setup: setupChecklist(status),
      example: { rent: 1500, card: feesFor(1500, 'card'), bank: feesFor(1500, 'us_bank_account') },
      tenants: { invited: access.filter(a => !a.disabled).length, joined: access.filter(a => a.acceptedAt && !a.disabled).length, autopay: access.filter(a => a.autopay && !a.disabled).length },
    });
  } catch (err) { next(err); }
});

router.post('/connect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.isAccountOwner) return res.status(403).json({ error: 'Only the account owner can connect a payout account.' });
    res.json({ url: await connectOnboardingUrl(req.dbUserId!) });
  } catch (err) {
    if (err instanceof Error && /not set up/.test(err.message)) return res.status(503).json({ error: err.message });
    next(err);
  }
});

router.post('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.isAccountOwner) return res.status(403).json({ error: 'Only the account owner can open payouts.' });
    res.json({ url: await connectDashboardUrl(req.dbUserId!) });
  } catch (err) {
    if (err instanceof Error && /not set up|first/.test(err.message)) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// ─── Tenant portal invites ─────────────────────────────────
const ownTenant = (req: Request) => db.tenant.findFirst({ where: { id: req.params.tenantId, userId: req.dbUserId! }, select: { id: true, fullName: true, email: true } });

router.get('/tenants/:tenantId/invite', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(await ownTenant(req))) return res.status(404).json({ error: 'Tenant not found' });
    const a = await db.tenantPortalAccess.findUnique({ where: { tenantId: req.params.tenantId } });
    res.json(a ? { invited: !a.disabled, joined: !!a.acceptedAt && !a.disabled, autopay: a.autopay, invitedAt: a.invitedAt, acceptedAt: a.acceptedAt, email: a.email, link: a.inviteToken && !a.disabled ? `${process.env.FRONTEND_URL}/portal/join?token=${a.inviteToken}` : null } : { invited: false, joined: false });
  } catch (err) { next(err); }
});

/** Invite (or re-invite) a tenant: a one-time link, emailed when email is set up, and returned to copy. */
router.post('/tenants/:tenantId/invite', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const t = await ownTenant(req);
    if (!t) return res.status(404).json({ error: 'Tenant not found' });
    const r = await inviteTenant(req.dbUserId!, t, (typeof req.body?.email === 'string' && req.body.email.trim()) || null, !!req.body?.resetSignIn);
    const { link, emailed, email } = r;
    res.json({ link, emailed, email });
  } catch (err) { next(err); }
});

/** Who "Invite tenants" would invite: everyone on an active lease not on the portal yet. */
router.get('/invite-all', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ tenants: await notYetInvited(req.dbUserId!), emailConfigured: emailConfigured() }); } catch (err) { next(err); }
});

/** Invite them all at once (the owner presses it after seeing the list): each gets a link, emailed where possible. */
router.post('/invite-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const only = Array.isArray(req.body?.tenantIds) ? new Set(req.body.tenantIds.map(String)) : null;
    const list = (await notYetInvited(req.dbUserId!)).filter(t => !only || only.has(t.id));
    const results = [];
    for (const t of list) results.push({ id: t.id, fullName: t.fullName, place: t.place, ...(await inviteTenant(req.dbUserId!, t, null)) });
    res.json({ invited: results });
  } catch (err) { next(err); }
});

router.delete('/tenants/:tenantId/invite', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(await ownTenant(req))) return res.status(404).json({ error: 'Tenant not found' });
    await db.tenantPortalAccess.updateMany({ where: { tenantId: req.params.tenantId }, data: { disabled: true, inviteToken: null, autopay: false } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
