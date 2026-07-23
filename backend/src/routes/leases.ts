import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const LeaseSchema = z.object({
  unitId: z.string(),
  startDate: z.string().transform(s => new Date(s)),
  endDate: z.string().transform(s => new Date(s)).optional().nullable(),
  rentAmount: z.number().positive(),
  section8Amount: z.number().optional().nullable(),
  securityDeposit: z.number().optional().nullable(),
  leaseType: z.enum(['FIXED_TERM', 'MONTH_TO_MONTH']).default('MONTH_TO_MONTH'),
  status: z.enum(['ACTIVE', 'ENDED', 'PENDING', 'TERMINATED']).default('ACTIVE'),
  documentUrl: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  tenantIds: z.array(z.string()).optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const { propertyId, status } = req.query;
    const leases = await db.lease.findMany({
      where: {
        unit: {
          property: { userId: req.dbUserId! },
          ...(propertyId ? { propertyId: propertyId as string } : {}),
        },
        ...(status ? { status: status as any } : {}),
      },
      include: {
        unit: { include: { property: { select: { id: true, address: true, nickname: true } } } },
        leaseTenants: { include: { tenant: true } },
        rentPayments: { orderBy: { paidDate: 'desc' }, take: 6 },
      },
      orderBy: { startDate: 'desc' },
    });
    res.json(leases);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const lease = await db.lease.findFirst({
      where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } },
      include: {
        unit: { include: { property: true } },
        leaseTenants: { include: { tenant: true } },
        rentPayments: { orderBy: { paidDate: 'desc' } },
        rentNotices: { orderBy: { noticeDate: 'desc' } },
      },
    });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    res.json(lease);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { tenantIds, ...rest } = LeaseSchema.parse(req.body);
    const unit = await db.unit.findFirst({ where: { id: rest.unitId, property: { userId: req.dbUserId! } } });
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    const lease = await db.lease.create({
      data: {
        ...rest,
        leaseTenants: tenantIds?.length
          ? { create: tenantIds.map((tid, i) => ({ tenantId: tid, isPrimary: i === 0 })) }
          : undefined,
      },
      include: { leaseTenants: { include: { tenant: true } } },
    });
    res.status(201).json(lease);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { tenantIds, ...rest } = LeaseSchema.partial().parse(req.body);
    const existing = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!existing) return res.status(404).json({ error: 'Lease not found' });
    const lease = await db.lease.update({ where: { id: req.params.id }, data: rest });
    res.json(lease);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!existing) return res.status(404).json({ error: 'Lease not found' });
    await db.lease.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
