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

const LEGAL_STATUSES = [
  'OPEN', 'PENDING_FILING', 'FILED', 'IN_LITIGATION', 'DISCOVERY', 'AWAITING_HEARING',
  'JUDGMENT', 'APPEAL', 'SETTLED', 'DISMISSED', 'COLLECTIONS', 'ON_HOLD', 'CLOSED',
] as const;

// Dates arrive as strings; empty string means "clear it", not "epoch".
const dateField = z.union([z.string(), z.null()])
  .transform(v => (v == null || v === '' ? null : new Date(v)))
  .optional();

const moneyField = z.union([z.number(), z.null()]).optional();
const textField = z.string().optional().nullable();

const LegalSchema = z.object({
  propertyId: textField,
  leaseId: textField,
  title: z.string().min(1),
  matterType: z.string().min(1),
  status: z.enum(LEGAL_STATUSES).default('OPEN'),
  priority: textField,
  filedDate: dateField,
  closedDate: dateField,
  nextHearingDate: dateField,
  responseDueDate: dateField,
  statuteDeadline: dateField,
  attorney: textField,
  attorneyFirm: textField,
  attorneyEmail: textField,
  attorneyPhone: textField,
  court: textField,
  jurisdiction: textField,
  judge: textField,
  caseNumber: textField,
  opposingParty: textField,
  opposingCounsel: textField,
  claimAmount: moneyField,
  judgmentAmount: moneyField,
  amountCollected: moneyField,
  settlementAmount: moneyField,
  outcome: textField,
  description: textField,
  notes: textField,
});

// Statuses that mean the matter is finished. Used for the open/closed split
// everywhere, so it lives in one place rather than being re-listed per query.
const CLOSED_STATUSES = ['CLOSED', 'SETTLED', 'DISMISSED'];

// Confirm a property/lease belongs to the requester before attaching a matter
// to it — otherwise a matter could be filed against someone else's property.
async function assertOwnership(userId: string, propertyId?: string | null, leaseId?: string | null) {
  if (propertyId) {
    const p = await db.property.findFirst({ where: { id: propertyId, userId }, select: { id: true } });
    if (!p) throw Object.assign(new Error('Property not found'), { status: 404 });
  }
  if (leaseId) {
    const l = await db.lease.findFirst({
      where: { id: leaseId, unit: { property: { userId } } }, select: { id: true },
    });
    if (!l) throw Object.assign(new Error('Lease not found'), { status: 404 });
  }
}

const matterInclude = {
  property: { select: { id: true, address: true, nickname: true } },
  lease: {
    select: {
      id: true,
      unit: { select: { unitLabel: true, property: { select: { id: true, address: true, nickname: true } } } },
      leaseTenants: { select: { tenant: { select: { id: true, fullName: true } } } },
    },
  },
  events: { orderBy: { date: 'desc' as const } },
  fees: { orderBy: { date: 'desc' as const } },
};

// ─── Matters ────────────────────────────────────────────────────────────────

// GET /api/legal — list matters, with optional property/status/type filters.
router.get('/', async (req, res, next) => {
  try {
    const { propertyId, status, matterType, open } = req.query;
    const matters = await db.legalMatter.findMany({
      where: {
        userId: req.dbUserId!,
        ...(propertyId ? { propertyId: propertyId as string } : {}),
        ...(status ? { status: status as any } : {}),
        ...(matterType ? { matterType: matterType as string } : {}),
        ...(open === 'true' ? { status: { notIn: CLOSED_STATUSES as any } } : {}),
        ...(open === 'false' ? { status: { in: CLOSED_STATUSES as any } } : {}),
      },
      include: matterInclude,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    res.json(matters);
  } catch (err) { next(err); }
});

// GET /api/legal/summary — portfolio-level counts, exposure and deadlines.
router.get('/summary', async (req, res, next) => {
  try {
    const matters = await db.legalMatter.findMany({
      where: { userId: req.dbUserId! },
      include: { fees: true, property: { select: { address: true, nickname: true } } },
    });

    const open = matters.filter(m => !CLOSED_STATUSES.includes(m.status));
    const num = (v: any) => Number(v ?? 0);
    const feesFor = (m: (typeof matters)[number]) => m.fees.reduce((s, f) => s + num(f.amount), 0);

    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 86_400_000);

    // Anything with a date in the next 30 days, flattened into one list so the
    // UI can show "what needs attention" without three separate queries.
    const upcoming: { matterId: string; title: string; kind: string; date: Date }[] = [];
    for (const m of open) {
      const add = (kind: string, d: Date | null) => {
        if (d && d >= now && d <= in30) upcoming.push({ matterId: m.id, title: m.title, kind, date: d });
      };
      add('Hearing', m.nextHearingDate);
      add('Response due', m.responseDueDate);
      add('Filing deadline', m.statuteDeadline);
    }
    upcoming.sort((a, b) => a.date.getTime() - b.date.getTime());

    const byType: Record<string, number> = {};
    for (const m of open) byType[m.matterType] = (byType[m.matterType] ?? 0) + 1;

    res.json({
      totalMatters: matters.length,
      openMatters: open.length,
      byType,
      totalFees: matters.reduce((s, m) => s + feesFor(m), 0),
      unpaidFees: matters.reduce(
        (s, m) => s + m.fees.filter(f => !f.isPaid).reduce((t, f) => t + num(f.amount), 0), 0),
      claimExposure: open.reduce((s, m) => s + num(m.claimAmount), 0),
      judgmentsAwarded: matters.reduce((s, m) => s + num(m.judgmentAmount), 0),
      judgmentsCollected: matters.reduce((s, m) => s + num(m.amountCollected), 0),
      overdueDeadlines: open.filter(m =>
        (m.responseDueDate && m.responseDueDate < now) || (m.statuteDeadline && m.statuteDeadline < now)).length,
      upcoming: upcoming.slice(0, 20),
    });
  } catch (err) { next(err); }
});

// GET /api/legal/:id — one matter with its timeline, fees and documents.
router.get('/:id', async (req, res, next) => {
  try {
    const matter = await db.legalMatter.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
      include: matterInclude,
    });
    if (!matter) return res.status(404).json({ error: 'Legal matter not found' });
    const documents = await db.document.findMany({
      where: { userId: req.dbUserId!, linkedType: 'LegalMatter', linkedId: matter.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ ...matter, documents });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = LegalSchema.parse(req.body);
    await assertOwnership(req.dbUserId!, data.propertyId, data.leaseId);
    const matter = await db.legalMatter.create({
      data: { ...data, userId: req.dbUserId! },
      include: matterInclude,
    });
    res.status(201).json(matter);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const data = LegalSchema.partial().parse(req.body);
    const existing = await db.legalMatter.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Legal matter not found' });
    await assertOwnership(req.dbUserId!, data.propertyId, data.leaseId);

    // Closing a matter without a date leaves the record undatable later, so
    // stamp it; reopening one clears the stale date.
    const patch: any = { ...data };
    if (data.status && CLOSED_STATUSES.includes(data.status) && !existing.closedDate && data.closedDate === undefined) {
      patch.closedDate = new Date();
    }
    if (data.status && !CLOSED_STATUSES.includes(data.status) && existing.closedDate && data.closedDate === undefined) {
      patch.closedDate = null;
    }

    const matter = await db.legalMatter.update({
      where: { id: req.params.id }, data: patch, include: matterInclude,
    });
    res.json(matter);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.legalMatter.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Legal matter not found' });

    // Documents are Cascade-free by design (they live in the Document table),
    // so clear their link rather than orphaning rows that point at nothing.
    await db.document.updateMany({
      where: { userId: req.dbUserId!, linkedType: 'LegalMatter', linkedId: existing.id },
      data: { linkedType: null, linkedId: null },
    });
    await db.legalMatter.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Timeline events ────────────────────────────────────────────────────────

const EventSchema = z.object({
  date: z.string().transform(s => new Date(s)),
  eventType: z.string().min(1),
  title: z.string().min(1),
  notes: textField,
  outcome: textField,
  isCompleted: z.boolean().default(true),
});

async function ownMatter(userId: string, id: string) {
  return db.legalMatter.findFirst({ where: { id, userId }, select: { id: true } });
}

router.post('/:id/events', async (req, res, next) => {
  try {
    const data = EventSchema.parse(req.body);
    const matter = await ownMatter(req.dbUserId!, req.params.id);
    if (!matter) return res.status(404).json({ error: 'Legal matter not found' });
    const event = await db.legalEvent.create({ data: { ...data, legalMatterId: matter.id } });
    res.status(201).json(event);
  } catch (err) { next(err); }
});

router.patch('/:id/events/:eventId', async (req, res, next) => {
  try {
    const data = EventSchema.partial().parse(req.body);
    const matter = await ownMatter(req.dbUserId!, req.params.id);
    if (!matter) return res.status(404).json({ error: 'Legal matter not found' });
    const result = await db.legalEvent.updateMany({
      where: { id: req.params.eventId, legalMatterId: matter.id }, data,
    });
    if (result.count === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(await db.legalEvent.findUnique({ where: { id: req.params.eventId } }));
  } catch (err) { next(err); }
});

router.delete('/:id/events/:eventId', async (req, res, next) => {
  try {
    const matter = await ownMatter(req.dbUserId!, req.params.id);
    if (!matter) return res.status(404).json({ error: 'Legal matter not found' });
    await db.legalEvent.deleteMany({ where: { id: req.params.eventId, legalMatterId: matter.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Fees and payments ──────────────────────────────────────────────────────

const FeeSchema = z.object({
  date: z.string().transform(s => new Date(s)),
  category: z.string().min(1),
  description: textField,
  amount: z.number(),
  hours: moneyField,
  hourlyRate: moneyField,
  payee: textField,
  invoiceNumber: textField,
  isPaid: z.boolean().default(false),
  paidDate: dateField,
  bankAccountId: textField,
  notes: textField,
});

router.post('/:id/fees', async (req, res, next) => {
  try {
    const data = FeeSchema.parse(req.body);
    const matter = await ownMatter(req.dbUserId!, req.params.id);
    if (!matter) return res.status(404).json({ error: 'Legal matter not found' });
    if (data.bankAccountId) {
      const acct = await db.bankAccount.findFirst({ where: { id: data.bankAccountId, userId: req.dbUserId! } });
      if (!acct) return res.status(404).json({ error: 'Bank account not found' });
    }
    // Marking a fee paid with no date leaves it unreportable by period.
    const paidDate = data.isPaid ? (data.paidDate ?? new Date()) : null;
    const fee = await db.legalFee.create({ data: { ...data, paidDate, legalMatterId: matter.id } });
    res.status(201).json(fee);
  } catch (err) { next(err); }
});

router.patch('/:id/fees/:feeId', async (req, res, next) => {
  try {
    const data = FeeSchema.partial().parse(req.body);
    const matter = await ownMatter(req.dbUserId!, req.params.id);
    if (!matter) return res.status(404).json({ error: 'Legal matter not found' });
    if (data.bankAccountId) {
      const acct = await db.bankAccount.findFirst({ where: { id: data.bankAccountId, userId: req.dbUserId! } });
      if (!acct) return res.status(404).json({ error: 'Bank account not found' });
    }
    const patch: any = { ...data };
    if (data.isPaid === true && data.paidDate === undefined) patch.paidDate = new Date();
    if (data.isPaid === false) patch.paidDate = null;
    const result = await db.legalFee.updateMany({
      where: { id: req.params.feeId, legalMatterId: matter.id }, data: patch,
    });
    if (result.count === 0) return res.status(404).json({ error: 'Fee not found' });
    res.json(await db.legalFee.findUnique({ where: { id: req.params.feeId } }));
  } catch (err) { next(err); }
});

router.delete('/:id/fees/:feeId', async (req, res, next) => {
  try {
    const matter = await ownMatter(req.dbUserId!, req.params.id);
    if (!matter) return res.status(404).json({ error: 'Legal matter not found' });
    await db.legalFee.deleteMany({ where: { id: req.params.feeId, legalMatterId: matter.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Documents ──────────────────────────────────────────────────────────────
// Reuses the generic Document table (linkedType='LegalMatter'), so legal
// paperwork gets the same S3 storage and signed-URL access as everything else
// rather than a parallel mechanism.

const LegalDocSchema = z.object({
  fileData: z.string(),
  filename: z.string().optional(),
  category: z.enum(['LEGAL', 'CONTRACT', 'COURT_FILING', 'CORRESPONDENCE', 'IDENTITY', 'OTHER']).default('LEGAL'),
  title: textField,
  notes: textField,
});

router.get('/:id/documents', async (req, res, next) => {
  try {
    const matter = await ownMatter(req.dbUserId!, req.params.id);
    if (!matter) return res.status(404).json({ error: 'Legal matter not found' });
    res.json(await db.document.findMany({
      where: { userId: req.dbUserId!, linkedType: 'LegalMatter', linkedId: matter.id },
      orderBy: { createdAt: 'desc' },
    }));
  } catch (err) { next(err); }
});

router.post('/:id/documents', async (req, res, next) => {
  try {
    const data = LegalDocSchema.parse(req.body);
    const matter = await db.legalMatter.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
      select: { id: true, propertyId: true },
    });
    if (!matter) return res.status(404).json({ error: 'Legal matter not found' });

    const buffer = Buffer.from(data.fileData, 'base64');
    const filename = data.filename || `${data.category.toLowerCase()}.pdf`;
    const key = `${req.dbUserId}/legal/${matter.id}/${data.category}_${Date.now()}_${sanitizeFilename(filename)}`;
    const s3Url = await uploadDocument(key, buffer);

    const doc = await db.document.create({
      data: {
        userId: req.dbUserId!,
        propertyId: matter.propertyId,
        category: data.category as any,
        title: data.title || filename,
        s3Key: key,
        s3Url,
        sourceType: 'UPLOAD',
        linkedType: 'LegalMatter',
        linkedId: matter.id,
        notes: data.notes || null,
      },
    });
    res.status(201).json(doc);
  } catch (err) { next(err); }
});

router.get('/:id/documents/:docId/url', async (req, res, next) => {
  try {
    const matter = await ownMatter(req.dbUserId!, req.params.id);
    if (!matter) return res.status(404).json({ error: 'Legal matter not found' });
    const doc = await db.document.findFirst({
      where: { id: req.params.docId, userId: req.dbUserId!, linkedType: 'LegalMatter', linkedId: matter.id },
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json({ url: await getSignedDocumentUrl(doc.s3Key) });
  } catch (err) { next(err); }
});

router.delete('/:id/documents/:docId', async (req, res, next) => {
  try {
    const matter = await ownMatter(req.dbUserId!, req.params.id);
    if (!matter) return res.status(404).json({ error: 'Legal matter not found' });
    const doc = await db.document.findFirst({
      where: { id: req.params.docId, userId: req.dbUserId!, linkedType: 'LegalMatter', linkedId: matter.id },
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    // Matches the other document routes: the row goes, the S3 object is left
    // in place (there is no delete helper in s3Service).
    await db.document.delete({ where: { id: doc.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
