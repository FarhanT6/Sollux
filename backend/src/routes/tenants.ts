import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const TenantSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.get('/', async (req, res, next) => {
  try {
    const tenants = await db.tenant.findMany({
      where: { userId: req.dbUserId! },
      include: {
        leaseTenants: {
          include: { lease: { include: { unit: { include: { property: { select: { id: true, address: true, nickname: true } } } } } } },
        },
      },
      orderBy: { fullName: 'asc' },
    });
    res.json(tenants);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = TenantSchema.parse(req.body);
    const tenant = await db.tenant.create({ data: { ...data, userId: req.dbUserId! } });
    res.status(201).json(tenant);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const data = TenantSchema.partial().parse(req.body);
    const existing = await db.tenant.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Tenant not found' });
    const tenant = await db.tenant.update({ where: { id: req.params.id }, data });
    res.json(tenant);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.tenant.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Tenant not found' });
    await db.tenant.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
