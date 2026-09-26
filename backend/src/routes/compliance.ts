/**
 * Citations, orders to comply, permits and inspections, one property each.
 * A citation is a deadline as much as a bill: a date to correct by, a date
 * to pay by, and a fine that escalates if either passes. Money paid toward
 * one is an ordinary Expense (CITATIONS_FINES or PERMITS) linked back here,
 * so it counts in the property's expenses and P&L like any other.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument, getSignedDocumentUrl } from '../services/s3Service';
import { readDocument } from '../services/documentReader';

const router = Router();
router.use(attachDbUser);

const day = z.string().nullable().optional().transform(s => (s ? new Date(s) : s === null ? null : undefined));
const File = z.object({ name: z.string(), data: z.string() });

const Fields = z.object({
  propertyId: z.string(),
  kind: z.enum(['CITATION', 'NOTICE', 'PERMIT', 'INSPECTION']),
  title: z.string().min(1),
  agency: z.string().nullable().optional(),
  caseNumber: z.string().nullable().optional(),
  referenceNumber: z.string().nullable().optional(),
  level: z.enum(['WARNING', 'FIRST', 'SECOND', 'THIRD', 'FOURTH']).nullable().optional(),
  issuedDate: day, violationDate: day, dueDate: day, paymentDueDate: day, resolvedDate: day,
  fineAmount: z.number().nonnegative().nullable().optional(),
  apn: z.string().nullable().optional(),
  escalation: z.string().nullable().optional(),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'APPEALED', 'CLOSED']).optional(),
  violations: z.array(z.object({
    code: z.string().nullable().optional(), description: z.string().nullable().optional(),
    correction: z.string().nullable().optional(), fine: z.number().nullable().optional(),
  })).nullable().optional(),
  contactName: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  contactEmail: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  /** New pages to attach: a scan, or phone photos of each page. */
  files: z.array(File).max(12).optional(),
});

const sanitize = (n: string) => n.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);

async function owned(id: string, userId: string) {
  return db.complianceItem.findFirst({ where: { id, userId } });
}

async function storeFiles(userId: string, propertyId: string, files: { name: string; data: string }[] | undefined) {
  const out: { key: string; name: string }[] = [];
  for (const f of files ?? []) {
    const key = `${userId}/compliance/${propertyId}/${Date.now()}_${sanitize(f.name)}`;
    await uploadDocument(key, Buffer.from(f.data, 'base64'));
    out.push({ key, name: f.name });
  }
  return out;
}

const withTotals = (item: any) => {
  const paid = (item.expenses ?? []).reduce((t: number, e: any) => t + Number(e.amount ?? 0), 0);
  const fine = item.fineAmount != null ? Number(item.fineAmount) : null;
  return { ...item, paid: Number(paid.toFixed(2)), owed: fine != null ? Math.max(0, Number((fine - paid).toFixed(2))) : null };
};

// GET / — every item, or one property's; open ones first by deadline.
router.get('/', async (req, res, next) => {
  try {
    const { propertyId, status } = req.query as Record<string, string | undefined>;
    const items = await db.complianceItem.findMany({
      where: {
        userId: req.dbUserId!,
        ...(propertyId ? { propertyId } : {}),
        ...(status === 'open' ? { status: { in: ['OPEN', 'IN_PROGRESS', 'APPEALED'] } } : status ? { status } : {}),
      },
      include: {
        property: { select: { id: true, address: true, nickname: true, city: true, state: true } },
        expenses: { select: { id: true, amount: true, date: true, category: true, vendor: true, description: true }, orderBy: { date: 'desc' } },
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    });
    res.json(items.map(withTotals));
  } catch (err) { next(err); }
});

// POST /read — the fields of a citation or notice from its pages; saves nothing.
router.post('/read', async (req, res, next) => {
  try {
    const { files } = z.object({ files: z.array(File).min(1).max(12) }).parse(req.body);
    res.json(await readDocument('citation', files, req.dbUserId!));
  } catch (err: any) {
    if (err?.message) return res.status(422).json({ error: err.message });
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { files, ...data } = Fields.parse(req.body);
    const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    const documents = await storeFiles(req.dbUserId!, data.propertyId, files);
    const item = await db.complianceItem.create({
      data: {
        ...(data as any), userId: req.dbUserId!,
        violations: data.violations ?? undefined,
        documents: documents.length ? documents : undefined,
      },
    });
    res.status(201).json(item);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const existing = await owned(req.params.id, req.dbUserId!);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const { files, ...data } = Fields.partial().parse(req.body);
    if (data.propertyId) {
      const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
      if (!property) return res.status(404).json({ error: 'Property not found' });
    }
    const added = await storeFiles(req.dbUserId!, data.propertyId ?? existing.propertyId, files);
    const documents = [...(((existing.documents as any[]) ?? [])), ...added];
    // Resolving an item stamps the day, unless a day was given.
    const resolving = data.status && ['RESOLVED', 'CLOSED'].includes(data.status) && !existing.resolvedDate && data.resolvedDate === undefined;
    const item = await db.complianceItem.update({
      where: { id: existing.id },
      data: {
        ...(data as any),
        ...(data.violations !== undefined ? { violations: data.violations ?? undefined } : {}),
        ...(added.length ? { documents } : {}),
        ...(resolving ? { resolvedDate: new Date() } : {}),
      },
    });
    res.json(item);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await owned(req.params.id, req.dbUserId!);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await db.complianceItem.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /:id/documents/:n — a signed URL for one attached page.
router.get('/:id/documents/:n', async (req, res, next) => {
  try {
    const existing = await owned(req.params.id, req.dbUserId!);
    const doc = ((existing?.documents as any[]) ?? [])[Number(req.params.n)];
    if (!existing || !doc) return res.status(404).json({ error: 'Not found' });
    res.json({ url: await getSignedDocumentUrl(doc.key), name: doc.name });
  } catch (err) { next(err); }
});

// POST /:id/payments — money paid toward the fine or the permit, as an expense.
router.post('/:id/payments', async (req, res, next) => {
  try {
    const existing = await owned(req.params.id, req.dbUserId!);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const body = z.object({
      amount: z.number().positive(), date: z.string(), vendor: z.string().nullable().optional(), description: z.string().nullable().optional(),
      category: z.enum(['CITATIONS_FINES', 'PERMITS', 'HANDYMAN', 'REPAIRS_MAINTENANCE', 'LEGAL', 'OTHER']).optional(),
    }).parse(req.body);
    const expense = await db.expense.create({
      data: {
        userId: req.dbUserId!, propertyId: existing.propertyId, complianceItemId: existing.id,
        category: body.category ?? (existing.kind === 'PERMIT' ? 'PERMITS' : 'CITATIONS_FINES'),
        amount: body.amount, date: new Date(body.date),
        vendor: body.vendor ?? existing.agency ?? null,
        description: body.description ?? `${existing.title}${existing.caseNumber ? ` (case ${existing.caseNumber})` : ''}`,
      },
    });
    res.status(201).json(expense);
  } catch (err) { next(err); }
});

export default router;
