/**
 * The tenant portal's API. A tenant signs in (Clerk), claims the invite link
 * their landlord sent, and from then on sees only their own leases: what is
 * owed, paying it (card or bank) and autopay, their payment history, the
 * lease document, and repair requests with photos.
 *
 * Nothing here reaches owner data beyond the tenant's own leases, and no
 * owner route accepts a tenant's sign-in (attachDbUser refuses it).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getAuth } from '@clerk/express';
import { db } from '../config/db';
import { attachTenant } from '../middleware/requireAuth';
import { leaseBalance, feesFor, rentCheckoutUrl, autopaySetupUrl, type PayMethod } from '../services/rentCollection';
import { stripe } from '../config/stripe';
import { getSignedDocumentUrl } from '../services/s3Service';
import { savePhotos, photoUrls, alertOwner, URGENCY, CATEGORIES } from '../services/maintenance';

const router = Router();

// ─── Claiming an invite (signed in, not yet a tenant) ──────
router.post('/claim', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clerkUserId = getAuth(req)?.userId;
    if (!clerkUserId) return res.status(401).json({ error: 'Not signed in' });
    const token = String(req.body?.token ?? '');
    const a = token ? await db.tenantPortalAccess.findUnique({ where: { inviteToken: token } }) : null;
    if (!a || a.disabled) return res.status(404).json({ error: 'This invite link is not valid. Ask your landlord for a new one.' });
    if (a.inviteExpiresAt && a.inviteExpiresAt < new Date()) return res.status(410).json({ error: 'This invite link has expired. Ask your landlord for a new one.' });
    // An owner's own sign-in cannot become a tenant's: it would lose the owner pages.
    if (await db.user.findUnique({ where: { clerkUserId }, select: { id: true } })) {
      return res.status(409).json({ error: 'You are signed in with a Sollux owner account. Sign out, then open the link again and create a tenant sign-in.' });
    }
    const other = await db.tenantPortalAccess.findUnique({ where: { clerkUserId } });
    if (other && other.id !== a.id) return res.status(409).json({ error: 'This sign-in is already linked to another tenancy.' });
    await db.tenantPortalAccess.update({ where: { id: a.id }, data: { clerkUserId, acceptedAt: new Date(), inviteToken: null, inviteExpiresAt: null } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.use(attachTenant);

/** The tenant's active (and most recent) leases, with what each owes. */
async function leasesOf(tenantId: string) {
  return db.lease.findMany({
    where: { leaseTenants: { some: { tenantId } }, status: { in: ['ACTIVE', 'PENDING'] } },
    orderBy: { startDate: 'desc' },
    select: {
      id: true, rentAmount: true, rentDueDay: true, startDate: true, endDate: true, leaseType: true, documentUrl: true, lateFeeAmount: true, lateFeePercent: true, lateFeeGraceDays: true,
      unit: { select: { id: true, unitLabel: true, property: { select: { id: true, address: true, city: true, state: true, nickname: true, userId: true } } } },
    },
  });
}

router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = req.tenantAccess!;
    const [tenant, owner, leases] = await Promise.all([
      db.tenant.findUnique({ where: { id: a.tenantId }, select: { fullName: true, email: true, phone: true } }),
      db.user.findUnique({ where: { id: a.ownerUserId }, select: { fullName: true, connectChargesEnabled: true } }),
      leasesOf(a.tenantId),
    ]);
    const withBalance = await Promise.all(leases.map(async l => ({
      id: l.id, rent: Number(l.rentAmount), dueDay: l.rentDueDay ?? 1, startDate: l.startDate, endDate: l.endDate, leaseType: l.leaseType, hasDocument: !!l.documentUrl,
      lateFee: l.lateFeeAmount != null ? Number(l.lateFeeAmount) : l.lateFeePercent != null ? `${l.lateFeePercent}%` : null, graceDays: l.lateFeeGraceDays,
      address: `${l.unit.property.address}${l.unit.unitLabel ? `, ${l.unit.unitLabel}` : ''}`, city: [l.unit.property.city, l.unit.property.state].filter(Boolean).join(', '),
      balance: await leaseBalance(l.id),
    })));
    res.json({
      tenant, landlord: owner?.fullName ?? 'Your landlord',
      onlinePayments: !!stripe && !!owner?.connectChargesEnabled,
      autopay: { on: a.autopay, label: a.autopayLabel, method: a.autopayMethodType },
      leases: withBalance,
    });
  } catch (err) { next(err); }
});

/** What paying an amount would cost each way, for the pay screen. */
router.get('/fees', (req: Request, res: Response) => {
  const amount = Math.max(0, Number(req.query.amount) || 0);
  res.json({ card: feesFor(amount, 'card'), bank: feesFor(amount, 'us_bank_account') });
});

router.get('/payments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leaseIds = (await leasesOf(req.tenantAccess!.tenantId)).map(l => l.id);
    const rows = await db.rentPayment.findMany({
      where: { leaseId: { in: leaseIds } }, orderBy: { paidDate: 'desc' }, take: 36,
      select: { id: true, amount: true, paidDate: true, periodDate: true, method: true, status: true, tenantFee: true, stripePaymentIntentId: true },
    });
    res.json(rows.map(r => ({ ...r, amount: Number(r.amount), tenantFee: r.tenantFee == null ? null : Number(r.tenantFee), online: !!r.stripePaymentIntentId, stripePaymentIntentId: undefined })));
  } catch (err) { next(err); }
});

const ownLease = async (req: Request, leaseId: string) => (await leasesOf(req.tenantAccess!.tenantId)).find(l => l.id === leaseId) ?? null;

router.post('/pay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({ leaseId: z.string(), amount: z.number().min(1).max(100000), method: z.enum(['card', 'us_bank_account']) }).parse(req.body);
    if (!(await ownLease(req, body.leaseId))) return res.status(404).json({ error: 'Lease not found' });
    res.json({ url: await rentCheckoutUrl(req.tenantAccess!, body.leaseId, body.amount, body.method as PayMethod) });
  } catch (err) {
    if (err instanceof Error && /landlord|not set up|amount/.test(err.message)) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.post('/autopay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { method } = z.object({ method: z.enum(['card', 'us_bank_account']) }).parse(req.body);
    res.json({ url: await autopaySetupUrl(req.tenantAccess!, method as PayMethod) });
  } catch (err) {
    if (err instanceof Error && /landlord|not set up/.test(err.message)) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.delete('/autopay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = req.tenantAccess!;
    await db.tenantPortalAccess.update({ where: { id: a.id }, data: { autopay: false } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/leases/:id/document', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const l = await ownLease(req, req.params.id);
    if (!l?.documentUrl) return res.status(404).json({ error: 'No lease document on file.' });
    res.json({ url: await getSignedDocumentUrl(l.documentUrl) });
  } catch (err) { next(err); }
});

// ─── Repair requests ───────────────────────────────────────
router.get('/requests', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await db.maintenanceRequest.findMany({
      where: { tenantId: req.tenantAccess!.tenantId }, orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, title: true, category: true, urgency: true, status: true, scheduledFor: true, createdAt: true, completedAt: true },
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/requests/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await db.maintenanceRequest.findFirst({ where: { id: req.params.id, tenantId: req.tenantAccess!.tenantId }, include: { updates: { orderBy: { createdAt: 'asc' } } } });
    if (!r) return res.status(404).json({ error: 'Request not found' });
    // The owner's cost, vendor and expense are the owner's business.
    const { cost: _c, expenseId: _e, vendor: _v, ownerUserId: _o, photoKeys, ...rest } = r;
    res.json({ ...rest, photos: await photoUrls(photoKeys) });
  } catch (err) { next(err); }
});

const NewRequest = z.object({
  leaseId: z.string(),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(5).max(4000),
  category: z.enum(CATEGORIES).default('OTHER'),
  urgency: z.enum(URGENCY).default('ROUTINE'),
  permissionToEnter: z.boolean().default(false),
  availability: z.string().max(300).optional().nullable(),
  photos: z.array(z.object({ name: z.string().optional(), data: z.string() })).max(6).default([]),
});

router.post('/requests', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = NewRequest.parse(req.body);
    const l = await ownLease(req, body.leaseId);
    if (!l) return res.status(404).json({ error: 'Lease not found' });
    const a = req.tenantAccess!;
    const r = await db.maintenanceRequest.create({
      data: {
        ownerUserId: a.ownerUserId, propertyId: l.unit.property.id, unitId: l.unit.id, leaseId: l.id, tenantId: a.tenantId,
        title: body.title, description: body.description, category: body.category, urgency: body.urgency,
        permissionToEnter: body.permissionToEnter, availability: body.availability ?? null, createdBy: 'TENANT',
      },
    });
    const { keys, failed } = await savePhotos(a.ownerUserId, r.id, body.photos);
    if (keys.length) await db.maintenanceRequest.update({ where: { id: r.id }, data: { photoKeys: keys } });
    void alertOwner(r.id);
    res.status(201).json({ id: r.id, photosSaved: keys.length, photosFailed: failed });
  } catch (err) { next(err); }
});

router.post('/requests/:id/updates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
    const r = await db.maintenanceRequest.findFirst({ where: { id: req.params.id, tenantId: req.tenantAccess!.tenantId }, select: { id: true } });
    if (!r) return res.status(404).json({ error: 'Request not found' });
    res.status(201).json(await db.maintenanceUpdate.create({ data: { requestId: r.id, author: 'TENANT', body } }));
  } catch (err) { next(err); }
});

export default router;
