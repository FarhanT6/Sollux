import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { computeStandardBreakdown } from '../lib/notices';

const router = Router();
router.use(attachDbUser);

// GET /api/notices?leaseId=&propertyId=
router.get('/', async (req, res, next) => {
  try {
    const { leaseId, propertyId } = req.query;
    const notices = await db.rentNotice.findMany({
      where: {
        lease: {
          unit: { property: { userId: req.dbUserId! } },
          ...(leaseId ? { id: leaseId as string } : {}),
          ...(propertyId ? { unit: { propertyId: propertyId as string } } : {}),
        },
      },
      include: { lease: { include: { unit: { include: { property: { select: { id: true, address: true, nickname: true } } } }, leaseTenants: { include: { tenant: true } } } } },
      orderBy: { noticeDate: 'desc' },
    });
    res.json(notices);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const notice = await db.rentNotice.findFirst({
      where: { id: req.params.id, lease: { unit: { property: { userId: req.dbUserId! } } } },
      include: {
        lease: {
          include: {
            unit: { include: { property: true } },
            leaseTenants: { include: { tenant: true } },
          },
        },
      },
    });
    if (!notice) return res.status(404).json({ error: 'Notice not found' });
    res.json(notice);
  } catch (err) { next(err); }
});

// GET /api/notices/preview/:leaseId — compute standard breakdown without saving
router.get('/preview/:leaseId', async (req, res, next) => {
  try {
    const lease = await db.lease.findFirst({
      where: { id: req.params.leaseId, unit: { property: { userId: req.dbUserId! } } },
    });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    const now = new Date();
    const currentPeriodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const currentPeriodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const payments = await db.rentPayment.findMany({ where: { leaseId: lease.id, periodDate: { gte: currentPeriodStart, lt: currentPeriodEnd } } });
    const credited = payments.reduce((s, p) => s + (Number(p.amount) - Number(p.appliedToArrears)), 0);
    const currentOwed = Math.max(0, Number(lease.rentAmount) - credited);
    const lineItems = computeStandardBreakdown(Number(lease.arrearsBalance), currentOwed, Number(lease.rentAmount), currentPeriodStart);
    res.json({ lineItems, totalDue: lineItems.reduce((s, i) => s + i.amount, 0) });
  } catch (err) { next(err); }
});

const NoticeSchema = z.object({
  leaseId: z.string(),
  noticeDate: z.string().transform(s => new Date(s)),
  lineItems: z.array(z.object({ amount: z.number(), dueDate: z.string() })),
  totalDue: z.number(),
  signedByName: z.string().min(1),
  signedByPhone: z.string().optional().nullable(),
  signedByEmail: z.string().optional().nullable(),
  signedByAddress: z.string().optional().nullable(),
});

router.post('/', async (req, res, next) => {
  try {
    const data = NoticeSchema.parse(req.body);
    const lease = await db.lease.findFirst({ where: { id: data.leaseId, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    const notice = await db.rentNotice.create({ data });
    res.status(201).json(notice);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.rentNotice.findFirst({ where: { id: req.params.id, lease: { unit: { property: { userId: req.dbUserId! } } } } });
    if (!existing) return res.status(404).json({ error: 'Notice not found' });
    await db.rentNotice.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
