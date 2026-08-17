import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument, getSignedDocumentUrl } from '../services/s3Service';

const router = Router();
router.use(attachDbUser);

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

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
  arrearsBalance: z.number().min(0).optional(),
  rentDueDay: z.number().int().min(1).max(31).optional().nullable(),
  tenantIds: z.array(z.string()).optional(),
  manualLikelihood: z.enum(['high', 'medium', 'low', 'none']).optional().nullable(),
  manualLikelihoodNote: z.string().optional().nullable(),
  // Next scheduled rent increase — any combination of date/amount/percent/note.
  nextIncreaseDate: z.string().transform(s => (s ? new Date(s) : null)).optional().nullable(),
  nextIncreaseAmount: z.number().optional().nullable(),
  nextIncreasePercent: z.number().optional().nullable(),
  nextIncreaseNote: z.string().optional().nullable(),
  // When rentAmount changes via PATCH, the effective date to stamp on the
  // auto-logged rent-change history row (defaults to today).
  rentEffectiveDate: z.string().transform(s => (s ? new Date(s) : null)).optional().nullable(),
  // Late fee: flat amount or percent of rent, with an optional grace period.
  lateFeeAmount: z.number().optional().nullable(),
  lateFeePercent: z.number().optional().nullable(),
  lateFeeGraceDays: z.number().int().optional().nullable(),
  // Commercial: business/entity on the lease.
  businessName: z.string().optional().nullable(),
});

const RentChangeSchema = z.object({
  effectiveDate: z.string().transform(s => new Date(s)),
  previousAmount: z.number().optional().nullable(),
  newAmount: z.number().positive(),
  note: z.string().optional().nullable(),
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
        rentChanges: { orderBy: { effectiveDate: 'desc' } },
        scheduledIncreases: { where: { applied: false }, orderBy: { effectiveDate: 'asc' } },
        utilityCharges: { orderBy: { createdAt: 'asc' } },
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
        rentChanges: { orderBy: { effectiveDate: 'desc' } },
        scheduledIncreases: { where: { applied: false }, orderBy: { effectiveDate: 'asc' } },
        utilityCharges: { orderBy: { createdAt: 'asc' } },
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
    const { tenantIds, rentEffectiveDate, ...rest } = LeaseSchema.partial().parse(req.body);
    const existing = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!existing) return res.status(404).json({ error: 'Lease not found' });

    // Auto-log a rent change when the rent amount actually changes.
    if (rest.rentAmount != null && Number(rest.rentAmount) !== Number(existing.rentAmount)) {
      await db.rentChange.create({
        data: {
          leaseId: existing.id,
          effectiveDate: rentEffectiveDate ?? new Date(),
          previousAmount: existing.rentAmount,
          newAmount: rest.rentAmount,
          note: 'Updated via edit',
        },
      });
    }

    // Sync co-tenants if a tenant list was provided (replace the set).
    if (tenantIds) {
      await db.leaseTenant.deleteMany({ where: { leaseId: existing.id } });
      if (tenantIds.length) {
        await db.leaseTenant.createMany({
          data: tenantIds.map((tid, i) => ({ leaseId: existing.id, tenantId: tid, isPrimary: i === 0 })),
          skipDuplicates: true,
        });
      }
    }

    const lease = await db.lease.update({
      where: { id: req.params.id },
      data: rest,
      include: {
        leaseTenants: { include: { tenant: true } },
        rentChanges: { orderBy: { effectiveDate: 'desc' } },
      },
    });
    res.json(lease);
  } catch (err) { next(err); }
});

// GET /api/leases/:id/rent-changes — rent change history for a lease
router.get('/:id/rent-changes', async (req, res, next) => {
  try {
    const lease = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    const changes = await db.rentChange.findMany({ where: { leaseId: lease.id }, orderBy: { effectiveDate: 'desc' } });
    res.json(changes);
  } catch (err) { next(err); }
});

// POST /api/leases/:id/rent-changes — manually add a past rent change
router.post('/:id/rent-changes', async (req, res, next) => {
  try {
    const data = RentChangeSchema.parse(req.body);
    const lease = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    const change = await db.rentChange.create({ data: { ...data, leaseId: lease.id } });
    res.status(201).json(change);
  } catch (err) { next(err); }
});

// DELETE /api/leases/:id/rent-changes/:changeId — remove a rent change entry
router.delete('/:id/rent-changes/:changeId', async (req, res, next) => {
  try {
    const lease = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    await db.rentChange.deleteMany({ where: { id: req.params.changeId, leaseId: lease.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── Lease utility charges (portion of payment that reimburses a utility) ────
const UtilityChargeSchema = z.object({
  category: z.string().min(1),
  amount: z.number(),
  note: z.string().optional().nullable(),
});

// POST /api/leases/:id/utility-charges — add a utility contribution line
router.post('/:id/utility-charges', async (req, res, next) => {
  try {
    const data = UtilityChargeSchema.parse(req.body);
    const lease = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    const created = await db.leaseUtilityCharge.create({ data: { ...data, leaseId: lease.id } });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

// DELETE /api/leases/:id/utility-charges/:chargeId — remove a line
router.delete('/:id/utility-charges/:chargeId', async (req, res, next) => {
  try {
    const lease = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    await db.leaseUtilityCharge.deleteMany({ where: { id: req.params.chargeId, leaseId: lease.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── Scheduled (future) rent increases ───────────────────────────────────────
const ScheduledIncreaseSchema = z.object({
  effectiveDate: z.string().transform(s => new Date(s)),
  newAmount: z.number().optional().nullable(),
  percent: z.number().optional().nullable(),
  percentMax: z.number().optional().nullable(),
  note: z.string().optional().nullable(),
});

// POST /api/leases/:id/scheduled-increases — add a planned increase
router.post('/:id/scheduled-increases', async (req, res, next) => {
  try {
    const data = ScheduledIncreaseSchema.parse(req.body);
    const lease = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    const created = await db.scheduledRentIncrease.create({ data: { ...data, leaseId: lease.id } });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

// POST /api/leases/:id/scheduled-increases/:sid/apply — apply a planned increase:
// set it as the current rent, log a rent-change history row, mark it applied.
router.post('/:id/scheduled-increases/:sid/apply', async (req, res, next) => {
  try {
    const lease = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    const sched = await db.scheduledRentIncrease.findFirst({ where: { id: req.params.sid, leaseId: lease.id } });
    if (!sched) return res.status(404).json({ error: 'Scheduled increase not found' });

    // Optional override at apply time — needed for a range (the user picks the
    // actual percent/amount within the planned range).
    const override = z.object({ percent: z.number().optional(), amount: z.number().optional() }).parse(req.body || {});

    const prev = Number(lease.rentAmount);
    const newAmount = override.amount != null
      ? override.amount
      : override.percent != null
        ? Math.round(prev * (1 + override.percent / 100) * 100) / 100
        : sched.newAmount != null
          ? Number(sched.newAmount)
          : sched.percent != null
            ? Math.round(prev * (1 + Number(sched.percent) / 100) * 100) / 100
            : prev;

    await db.rentChange.create({
      data: { leaseId: lease.id, effectiveDate: sched.effectiveDate, previousAmount: prev, newAmount, note: sched.note || 'Scheduled increase applied' },
    });
    await db.lease.update({ where: { id: lease.id }, data: { rentAmount: newAmount } });
    const updated = await db.scheduledRentIncrease.update({ where: { id: sched.id }, data: { applied: true } });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/leases/:id/scheduled-increases/:sid — remove a planned increase
router.delete('/:id/scheduled-increases/:sid', async (req, res, next) => {
  try {
    const lease = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    await db.scheduledRentIncrease.deleteMany({ where: { id: req.params.sid, leaseId: lease.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/leases/:id/document — upload a lease agreement PDF (base64 body)
router.post('/:id/document', async (req, res, next) => {
  try {
    const lease = await db.lease.findFirst({
      where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } },
      include: { unit: { select: { propertyId: true } } },
    });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });

    const { fileData, filename } = req.body as { fileData?: string; filename?: string };
    if (!fileData) return res.status(400).json({ error: 'fileData (base64) is required' });

    const buffer = Buffer.from(fileData, 'base64');
    const key = `${req.dbUserId}/${lease.unit.propertyId}/leases/${lease.id}/${sanitizeFilename(filename || 'lease.pdf')}`;
    const documentUrl = await uploadDocument(key, buffer);

    const updated = await db.lease.update({ where: { id: lease.id }, data: { documentUrl } });
    res.json(updated);
  } catch (err) { next(err); }
});

// GET /api/leases/:id/document — signed S3 URL for the lease agreement PDF
router.get('/:id/document', async (req, res, next) => {
  try {
    const lease = await db.lease.findFirst({
      where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } },
    });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    if (!lease.documentUrl) return res.status(404).json({ error: 'No document available' });

    const url = await getSignedDocumentUrl(lease.documentUrl);
    res.json({ url, expiresIn: 3600 });
  } catch (err) { next(err); }
});

// ── Tenant/lease attachments (application, ID, screening, etc.) ──────────────
// Stored as generic Documents linked to the lease (linkedType='Lease'), so
// they show alongside other property documents but scoped to this lease.
const LeaseDocSchema = z.object({
  fileData: z.string(),
  filename: z.string().optional(),
  category: z.enum(['LEASE', 'APPLICATION', 'IDENTITY', 'SCREENING', 'OTHER']).default('OTHER'),
  title: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// GET /api/leases/:id/documents — list attachments for a lease
router.get('/:id/documents', async (req, res, next) => {
  try {
    const lease = await db.lease.findFirst({ where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    const docs = await db.document.findMany({
      where: { userId: req.dbUserId!, linkedType: 'Lease', linkedId: lease.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(docs);
  } catch (err) { next(err); }
});

// POST /api/leases/:id/documents — attach a categorized document to a lease
router.post('/:id/documents', async (req, res, next) => {
  try {
    const data = LeaseDocSchema.parse(req.body);
    const lease = await db.lease.findFirst({
      where: { id: req.params.id, unit: { property: { userId: req.dbUserId! } } },
      include: { unit: { select: { propertyId: true } } },
    });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });

    const buffer = Buffer.from(data.fileData, 'base64');
    const filename = data.filename || `${data.category.toLowerCase()}.pdf`;
    const key = `${req.dbUserId}/${lease.unit.propertyId}/leases/${lease.id}/${data.category}_${Date.now()}_${sanitizeFilename(filename)}`;
    const s3Url = await uploadDocument(key, buffer);

    const doc = await db.document.create({
      data: {
        userId: req.dbUserId!,
        propertyId: lease.unit.propertyId,
        category: data.category as any,
        title: data.title || filename,
        s3Key: key,
        s3Url,
        sourceType: 'UPLOAD',
        linkedType: 'Lease',
        linkedId: lease.id,
        notes: data.notes || null,
      },
    });
    res.status(201).json(doc);
  } catch (err) { next(err); }
});

// GET /api/leases/:id/documents/:docId/url — signed URL to view an attachment
router.get('/:id/documents/:docId/url', async (req, res, next) => {
  try {
    const doc = await db.document.findFirst({
      where: { id: req.params.docId, userId: req.dbUserId!, linkedType: 'Lease', linkedId: req.params.id },
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const url = await getSignedDocumentUrl(doc.s3Key);
    res.json({ url });
  } catch (err) { next(err); }
});

// DELETE /api/leases/:id/documents/:docId — remove an attachment
router.delete('/:id/documents/:docId', async (req, res, next) => {
  try {
    await db.document.deleteMany({
      where: { id: req.params.docId, userId: req.dbUserId!, linkedType: 'Lease', linkedId: req.params.id },
    });
    res.status(204).send();
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
