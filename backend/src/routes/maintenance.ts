/**
 * Repairs, the owner's side: every request from the tenant portal (or logged
 * by the owner), scheduling and status, notes back and forth with the
 * tenant, and a completed repair's cost logged as a property expense.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { savePhotos, photoUrls, alertTenant, URGENCY, STATUSES, CATEGORIES, STATUS_WORDS } from '../services/maintenance';

const router = Router();
router.use(attachDbUser);

async function names(rows: { propertyId: string; unitId: string | null; tenantId: string | null }[]) {
  const [props, units, tenants] = await Promise.all([
    db.property.findMany({ where: { id: { in: [...new Set(rows.map(r => r.propertyId))] } }, select: { id: true, address: true, nickname: true } }),
    db.unit.findMany({ where: { id: { in: rows.map(r => r.unitId).filter(Boolean) as string[] } }, select: { id: true, unitLabel: true } }),
    db.tenant.findMany({ where: { id: { in: rows.map(r => r.tenantId).filter(Boolean) as string[] } }, select: { id: true, fullName: true, phone: true, email: true } }),
  ]);
  return { prop: new Map(props.map(p => [p.id, p])), unit: new Map(units.map(u => [u.id, u])), tenant: new Map(tenants.map(t => [t.id, t])) };
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : 'active';
    const where = {
      ownerUserId: req.dbUserId!,
      ...(status === 'active' ? { status: { in: ['OPEN', 'SCHEDULED', 'IN_PROGRESS'] } } : status === 'all' ? {} : { status }),
      ...(typeof req.query.propertyId === 'string' ? { propertyId: req.query.propertyId } : {}),
    };
    const rows = await db.maintenanceRequest.findMany({ where, orderBy: [{ createdAt: 'desc' }], take: 200, include: { _count: { select: { updates: true } } } });
    const n = await names(rows);
    const rank: Record<string, number> = { EMERGENCY: 0, URGENT: 1, ROUTINE: 2 };
    res.json(rows
      .map(r => ({
        id: r.id, title: r.title, category: r.category, urgency: r.urgency, status: r.status, createdAt: r.createdAt, scheduledFor: r.scheduledFor, completedAt: r.completedAt,
        cost: r.cost == null ? null : Number(r.cost), photos: Array.isArray(r.photoKeys) ? (r.photoKeys as unknown[]).length : 0, updates: r._count.updates, createdBy: r.createdBy,
        propertyId: r.propertyId, property: n.prop.get(r.propertyId)?.nickname || n.prop.get(r.propertyId)?.address || '', unit: r.unitId ? n.unit.get(r.unitId)?.unitLabel ?? null : null,
        tenant: r.tenantId ? n.tenant.get(r.tenantId)?.fullName ?? null : null,
      }))
      // Open emergencies first, then by urgency, newest first within each.
      .sort((a, b) => (a.status === 'COMPLETED' || a.status === 'CANCELLED' ? 1 : 0) - (b.status === 'COMPLETED' || b.status === 'CANCELLED' ? 1 : 0) || rank[a.urgency] - rank[b.urgency]));
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await db.maintenanceRequest.findFirst({ where: { id: req.params.id, ownerUserId: req.dbUserId! }, include: { updates: { orderBy: { createdAt: 'asc' } } } });
    if (!r) return res.status(404).json({ error: 'Request not found' });
    const n = await names([r]);
    const t = r.tenantId ? n.tenant.get(r.tenantId) : null;
    res.json({
      ...r, cost: r.cost == null ? null : Number(r.cost), photos: await photoUrls(r.photoKeys), photoKeys: undefined,
      property: n.prop.get(r.propertyId)?.nickname || n.prop.get(r.propertyId)?.address || '', unit: r.unitId ? n.unit.get(r.unitId)?.unitLabel ?? null : null,
      tenant: t ? { name: t.fullName, phone: t.phone, email: t.email } : null,
    });
  } catch (err) { next(err); }
});

const Create = z.object({
  propertyId: z.string(), unitId: z.string().optional().nullable(), tenantId: z.string().optional().nullable(),
  title: z.string().trim().min(3).max(120), description: z.string().trim().min(1).max(4000),
  category: z.enum(CATEGORIES).default('OTHER'), urgency: z.enum(URGENCY).default('ROUTINE'),
  photos: z.array(z.object({ name: z.string().optional(), data: z.string() })).max(6).default([]),
});

/** The owner logs a repair themselves (a call from a tenant, something seen on a walk-through). */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = Create.parse(req.body);
    const p = await db.property.findFirst({ where: { id: b.propertyId, userId: req.dbUserId! }, select: { id: true } });
    if (!p) return res.status(404).json({ error: 'Property not found' });
    const r = await db.maintenanceRequest.create({
      data: { ownerUserId: req.dbUserId!, propertyId: p.id, unitId: b.unitId ?? null, tenantId: b.tenantId ?? null, title: b.title, description: b.description, category: b.category, urgency: b.urgency, createdBy: 'OWNER' },
    });
    const { keys } = await savePhotos(req.dbUserId!, r.id, b.photos);
    if (keys.length) await db.maintenanceRequest.update({ where: { id: r.id }, data: { photoKeys: keys } });
    res.status(201).json({ id: r.id });
  } catch (err) { next(err); }
});

const Patch = z.object({
  status: z.enum(STATUSES).optional(),
  urgency: z.enum(URGENCY).optional(),
  scheduledFor: z.string().datetime().nullable().optional(),
  vendor: z.string().max(120).nullable().optional(),
  cost: z.number().min(0).max(1_000_000).nullable().optional(),
  /** Sent to the tenant with the change. */
  note: z.string().trim().max(2000).optional(),
});

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = Patch.parse(req.body);
    const r = await db.maintenanceRequest.findFirst({ where: { id: req.params.id, ownerUserId: req.dbUserId! } });
    if (!r) return res.status(404).json({ error: 'Request not found' });
    const updated = await db.maintenanceRequest.update({
      where: { id: r.id },
      data: {
        ...(b.status ? { status: b.status, completedAt: b.status === 'COMPLETED' ? r.completedAt ?? new Date() : null } : {}),
        ...(b.urgency ? { urgency: b.urgency } : {}),
        ...(b.scheduledFor !== undefined ? { scheduledFor: b.scheduledFor ? new Date(b.scheduledFor) : null } : {}),
        ...(b.vendor !== undefined ? { vendor: b.vendor } : {}),
        ...(b.cost !== undefined ? { cost: b.cost } : {}),
      },
    });
    const told: string[] = [];
    if (b.status && b.status !== r.status) told.push(`Status: ${STATUS_WORDS[b.status]}.`);
    if (b.scheduledFor) told.push(`Scheduled for ${new Date(b.scheduledFor).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Los_Angeles' })}.`);
    if (b.note) told.push(b.note);
    if (told.length) {
      await db.maintenanceUpdate.create({ data: { requestId: r.id, author: 'OWNER', body: told.join(' ') } });
      void alertTenant(r.id, told.join(' '));
    }
    res.json({ ...updated, cost: updated.cost == null ? null : Number(updated.cost) });
  } catch (err) { next(err); }
});

router.post('/:id/updates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
    const r = await db.maintenanceRequest.findFirst({ where: { id: req.params.id, ownerUserId: req.dbUserId! }, select: { id: true } });
    if (!r) return res.status(404).json({ error: 'Request not found' });
    const u = await db.maintenanceUpdate.create({ data: { requestId: r.id, author: 'OWNER', body } });
    void alertTenant(r.id, body);
    res.status(201).json(u);
  } catch (err) { next(err); }
});

/** Log the repair's cost as an expense on the property (once). */
router.post('/:id/expense', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await db.maintenanceRequest.findFirst({ where: { id: req.params.id, ownerUserId: req.dbUserId! } });
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.expenseId) return res.status(409).json({ error: 'Already logged as an expense.' });
    const amount = Number(req.body?.amount ?? r.cost);
    if (!(amount > 0)) return res.status(400).json({ error: 'Enter what the repair cost first.' });
    const e = await db.expense.create({
      data: {
        userId: req.dbUserId!, propertyId: r.propertyId, category: 'REPAIRS_MAINTENANCE', amount,
        date: r.completedAt ?? new Date(), vendor: r.vendor ?? null, description: `Repair: ${r.title}`,
      },
    });
    await db.maintenanceRequest.update({ where: { id: r.id }, data: { expenseId: e.id, cost: amount } });
    res.status(201).json({ expenseId: e.id });
  } catch (err) { next(err); }
});

export default router;
