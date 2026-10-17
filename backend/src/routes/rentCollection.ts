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
    const email = (typeof req.body?.email === 'string' && req.body.email.trim()) || t.email || null;
    const token = randomBytes(24).toString('base64url');
    const existing = await db.tenantPortalAccess.findUnique({ where: { tenantId: t.id } });
    // A tenant who already joined keeps their sign-in; a new link is for a new device or person only when asked.
    const data = { email, inviteToken: token, inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000), invitedAt: new Date(), disabled: false };
    if (existing) await db.tenantPortalAccess.update({ where: { id: existing.id }, data: req.body?.resetSignIn ? { ...data, clerkUserId: null, acceptedAt: null } : data });
    else await db.tenantPortalAccess.create({ data: { tenantId: t.id, ownerUserId: req.dbUserId!, ...data } });
    const link = `${process.env.FRONTEND_URL}/portal/join?token=${token}`;
    let emailed = false;
    if (email && emailConfigured()) {
      const owner = await db.user.findUnique({ where: { id: req.dbUserId! }, select: { fullName: true } });
      await sendAlertEmail({
        to: email, subject: `${owner?.fullName ?? 'Your landlord'} invited you to pay rent and request repairs online`,
        headline: `Your tenant portal is ready`,
        lines: [`Hi ${t.fullName.split(/\s+/)[0]},`, `${owner?.fullName ?? 'Your landlord'} uses Sollux. In your portal you can pay rent by bank transfer (free) or card, set up autopay, and send repair requests with photos.`, `The link below works for ${INVITE_DAYS} days.`],
        path: `/portal/join?token=${token}`,
      }).then(() => { emailed = true; }).catch(err => console.warn('[Portal] invite email failed:', err instanceof Error ? err.message : err));
    }
    res.json({ link, emailed, email });
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
