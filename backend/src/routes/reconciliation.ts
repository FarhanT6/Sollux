import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument, getSignedDocumentUrl, detectContentType } from '../services/s3Service';
import { readManagerStatement } from '../services/managerStatement';

const router = Router();
router.use(attachDbUser);

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

const ProfileSchema = z.object({
  name: z.string().min(1),
  propertyId: z.string().optional().nullable(),
  leaseId: z.string().optional().nullable(),
  managementFeeCategory: z.string().optional().nullable(),
  loanIds: z.array(z.string()).default([]),
  notes: z.string().optional().nullable(),
});

const LineItemSchema = z.object({
  type: z.enum(['RENT', 'LOAN_PAYMENT', 'EXPENSE', 'OTHER']),
  targetId: z.string().optional().nullable(),
  targetLabel: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  amount: z.number(),
  direction: z.enum(['CREDIT', 'DEBIT']),
  // The actual date this line hit the account (e.g. rent received 8/8, but
  // loan payments/mgmt fee deducted 8/3) — falls back to statementDate
  // when not set, so older statements without per-item dates still work.
  date: z.string().optional().nullable(),
  // Read statements carry each cost's category and property (a manager may
  // cover several), and lines the owner left out (already recorded, a draw).
  category: z.string().optional().nullable(),
  propertyId: z.string().optional().nullable(),
  include: z.boolean().optional(),
});

const StatementSchema = z.object({
  profileId: z.string(),
  statementDate: z.string().transform(s => new Date(s)),
  lineItems: z.array(LineItemSchema).min(1),
  notes: z.string().optional().nullable(),
});

// ── Profiles ────────────────────────────────────────────────
router.get('/profiles', async (req, res, next) => {
  try {
    const profiles = await db.reconciliationProfile.findMany({
      where: { userId: req.dbUserId! },
      include: { property: { select: { id: true, address: true, nickname: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json(profiles);
  } catch (err) { next(err); }
});

router.post('/profiles', async (req, res, next) => {
  try {
    const data = ProfileSchema.parse(req.body);
    if (data.propertyId) {
      const prop = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }
    const profile = await db.reconciliationProfile.create({ data: { ...data, userId: req.dbUserId! } });
    res.status(201).json(profile);
  } catch (err) { next(err); }
});

router.patch('/profiles/:id', async (req, res, next) => {
  try {
    const data = ProfileSchema.partial().parse(req.body);
    const existing = await db.reconciliationProfile.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    const profile = await db.reconciliationProfile.update({ where: { id: req.params.id }, data });
    res.json(profile);
  } catch (err) { next(err); }
});

router.delete('/profiles/:id', async (req, res, next) => {
  try {
    const existing = await db.reconciliationProfile.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    await db.reconciliationProfile.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── Statements ──────────────────────────────────────────────
router.get('/statements', async (req, res, next) => {
  try {
    const { profileId } = req.query;
    const statements = await db.reconciliationStatement.findMany({
      where: { userId: req.dbUserId!, ...(profileId ? { profileId: profileId as string } : {}) },
      include: { profile: { select: { id: true, name: true } } },
      orderBy: { statementDate: 'desc' },
    });
    res.json(statements);
  } catch (err) { next(err); }
});

router.post('/statements', async (req, res, next) => {
  try {
    const data = StatementSchema.parse(req.body);
    const profile = await db.reconciliationProfile.findFirst({ where: { id: data.profileId, userId: req.dbUserId! } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const netAmount = data.lineItems.reduce((s, li) => s + (li.direction === 'CREDIT' ? li.amount : -li.amount), 0);

    const statement = await db.reconciliationStatement.create({
      data: {
        userId: req.dbUserId!,
        profileId: data.profileId,
        statementDate: data.statementDate,
        lineItems: data.lineItems as unknown as Prisma.InputJsonValue,
        netAmount,
        notes: data.notes || null,
      },
    });
    res.status(201).json(statement);
  } catch (err) { next(err); }
});

// POST /api/reconciliation/statements/:id/document — attach the source PDF/image (base64 body)
router.post('/statements/:id/document', async (req, res, next) => {
  try {
    const statement = await db.reconciliationStatement.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!statement) return res.status(404).json({ error: 'Statement not found' });

    const { fileData, filename } = req.body as { fileData?: string; filename?: string };
    if (!fileData) return res.status(400).json({ error: 'fileData (base64) is required' });

    const buffer = Buffer.from(fileData, 'base64');
    const key = `${req.dbUserId}/reconciliation/${statement.profileId}/${statement.id}/${sanitizeFilename(filename || 'statement.pdf')}`;
    const documentUrl = await uploadDocument(key, buffer);

    const updated = await db.reconciliationStatement.update({
      where: { id: req.params.id },
      data: { documentS3Key: key, documentUrl },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /api/reconciliation/statements/:id/apply — creates the real
// RentPayment/LoanPayment/Expense records this statement's line items
// represent, in one transaction. A statement can only be applied once.
router.post('/statements/:id/apply', async (req, res, next) => {
  try {
    const statement = await db.reconciliationStatement.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!statement) return res.status(404).json({ error: 'Statement not found' });
    if (statement.status === 'APPLIED') return res.status(400).json({ error: 'Statement has already been applied' });

    const profile = await db.reconciliationProfile.findFirst({ where: { id: statement.profileId, userId: req.dbUserId! } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const lineItems = statement.lineItems as unknown as z.infer<typeof LineItemSchema>[];
    const periodDate = new Date(statement.statementDate.getFullYear(), statement.statementDate.getMonth(), 1);

    const rentPaymentIds: string[] = [];
    const loanPaymentIds: string[] = [];
    const expenseIds: string[] = [];

    await db.$transaction(async tx => {
      for (const item of lineItems) {
        if (item.include === false) continue;
        const itemDate = item.date ? new Date(item.date) : statement.statementDate;

        if (item.type === 'RENT' && item.targetId) {
          const p = await tx.rentPayment.create({
            data: {
              leaseId: item.targetId,
              // The month the rent was for: the line's own date when it has one.
              periodDate: item.date ? new Date(Date.UTC(itemDate.getUTCFullYear(), itemDate.getUTCMonth(), 1)) : periodDate,
              amount: item.amount,
              paidDate: itemDate,
              method: 'OTHER',
              notes: `Reconciled via ${profile.name} statement (${item.description ?? ''})`.trim(),
            },
          });
          rentPaymentIds.push(p.id);
        } else if (item.type === 'LOAN_PAYMENT' && item.targetId) {
          const p = await tx.loanPayment.create({
            data: {
              loanId: item.targetId,
              date: itemDate,
              amount: item.amount,
              status: 'PAID',
              notes: `Reconciled via ${profile.name} statement (${item.description ?? ''})`.trim(),
            },
          });
          loanPaymentIds.push(p.id);
        } else if (item.type === 'EXPENSE' && (item.propertyId ?? profile.propertyId)) {
          const e = await tx.expense.create({
            data: {
              userId: req.dbUserId!,
              propertyId: (item.propertyId ?? profile.propertyId)!,
              category: (item.category ?? profile.managementFeeCategory ?? 'PROPERTY_MANAGEMENT') as any,
              amount: item.amount,
              date: itemDate,
              vendor: profile.name,
              description: item.description || undefined,
              isCapEx: false,
              isPersonal: false,
            },
          });
          expenseIds.push(e.id);
        }
      }

      await tx.reconciliationStatement.update({
        where: { id: statement.id },
        data: {
          status: 'APPLIED',
          appliedAt: new Date(),
          createdRecordIds: { rentPaymentIds, loanPaymentIds, expenseIds } as unknown as Prisma.InputJsonValue,
        },
      });
    });

    const updated = await db.reconciliationStatement.findUnique({ where: { id: statement.id } });
    res.json(updated);
  } catch (err) { next(err); }
});

// ── Reading a statement ──────────────────────────────────────
// POST /api/reconciliation/read { fileData (base64), filename } — the
// statement read into lines and matched to properties, leases and loans
// (services/managerStatement.ts). The file is kept under the owner's
// folder so the statement saved from this draft carries it.
router.post('/read', async (req, res, next) => {
  try {
    const { fileData, filename } = z.object({ fileData: z.string().min(1), filename: z.string().max(200).default('statement.pdf') }).parse(req.body);
    const buffer = Buffer.from(fileData, 'base64');
    if (buffer.length > 25 * 1024 * 1024) return res.status(400).json({ error: 'That file is over 25 MB.' });
    const type = detectContentType(buffer, filename);
    if (!/^(application\/pdf|image\/)/.test(type)) return res.status(400).json({ error: 'Upload the statement as a PDF or a photo.' });
    const draft = await readManagerStatement(req.dbUserId!, buffer, filename);
    const documentKey = `${req.dbUserId}/reconciliation/uploads/${Date.now()}-${sanitizeFilename(filename)}`;
    await uploadDocument(documentKey, buffer);
    res.json({ ...draft, documentKey });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

const ImportSchema = z.object({
  profileId: z.string().optional().nullable(),
  managerName: z.string().min(1).max(120),
  statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  documentKey: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  lines: z.array(z.object({
    date: z.string().nullable().optional(), description: z.string().max(300), kind: z.string(), amount: z.number().positive(),
    direction: z.enum(['IN', 'OUT']), propertyId: z.string().nullable().optional(), leaseId: z.string().nullable().optional(),
    loanId: z.string().nullable().optional(), category: z.string().nullable().optional(), include: z.boolean(),
  })).min(1).max(500),
});

// POST /api/reconciliation/import — save a reviewed draft as a statement
// (under the manager's profile, made if new) and apply it: the rent,
// loan payments and costs it records become the owner's records.
router.post('/import', async (req, res, next) => {
  try {
    const d = ImportSchema.parse(req.body);
    const userId = req.dbUserId!;
    if (d.documentKey && !d.documentKey.startsWith(`${userId}/reconciliation/uploads/`)) return res.status(400).json({ error: 'That file is not yours.' });
    // Every record a line points at must be the owner's.
    const ids = (k: 'propertyId' | 'leaseId' | 'loanId') => [...new Set(d.lines.filter(l => l.include).map(l => l[k]).filter((x): x is string => !!x))];
    const [props, leases, loans] = await Promise.all([
      db.property.count({ where: { userId, id: { in: ids('propertyId') } } }),
      db.lease.count({ where: { unit: { property: { userId } }, id: { in: ids('leaseId') } } }),
      db.loan.count({ where: { userId, id: { in: ids('loanId') } } }),
    ]);
    if (props !== ids('propertyId').length || leases !== ids('leaseId').length || loans !== ids('loanId').length) return res.status(400).json({ error: 'A line points at a record that is not yours.' });
    for (const l of d.lines.filter(l => l.include)) {
      if (l.kind === 'RENT' && !l.leaseId) return res.status(400).json({ error: `Choose the lease for "${l.description}", or leave it out.` });
      if (l.kind === 'LOAN_PAYMENT' && !l.loanId) return res.status(400).json({ error: `Choose the loan for "${l.description}", or leave it out.` });
      if (['MANAGEMENT_FEE', 'REPAIR', 'UTILITY', 'OTHER_EXPENSE'].includes(l.kind) && !l.propertyId) return res.status(400).json({ error: `Choose the property for "${l.description}", or leave it out.` });
    }

    let profile = d.profileId ? await db.reconciliationProfile.findFirst({ where: { id: d.profileId, userId } }) : null;
    if (!profile) {
      const only = ids('propertyId');
      profile = await db.reconciliationProfile.create({
        data: { userId, name: d.managerName, propertyId: only.length === 1 ? only[0] : null, managementFeeCategory: 'PROPERTY_MANAGEMENT', loanIds: ids('loanId') as unknown as Prisma.InputJsonValue },
      });
    }
    const lineItems = d.lines.map(l => ({
      type: l.kind === 'RENT' ? 'RENT' : l.kind === 'LOAN_PAYMENT' ? 'LOAN_PAYMENT' : ['MANAGEMENT_FEE', 'REPAIR', 'UTILITY', 'OTHER_EXPENSE'].includes(l.kind) ? 'EXPENSE' : 'OTHER',
      targetId: l.kind === 'RENT' ? l.leaseId ?? null : l.kind === 'LOAN_PAYMENT' ? l.loanId ?? null : null,
      targetLabel: l.kind, description: l.description, amount: l.amount, direction: l.direction === 'IN' ? 'CREDIT' : 'DEBIT',
      date: l.date ?? null, category: l.category ?? null, propertyId: l.propertyId ?? null, include: l.include,
    }));
    const net = lineItems.reduce((t, li) => t + (li.direction === 'CREDIT' ? li.amount : -li.amount), 0);
    const statement = await db.reconciliationStatement.create({
      data: {
        userId, profileId: profile.id, statementDate: new Date(`${d.statementDate}T00:00:00.000Z`),
        lineItems: lineItems as unknown as Prisma.InputJsonValue, netAmount: Math.round(net * 100) / 100, notes: d.notes ?? null,
        documentS3Key: d.documentKey ?? null,
      },
    });
    res.status(201).json({ id: statement.id, profileId: profile.id });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Some lines are incomplete.' });
    next(err);
  }
});

// GET /api/reconciliation/statements/:id/document — the statement file, through a signed link.
router.get('/statements/:id/document', async (req, res, next) => {
  try {
    const s = await db.reconciliationStatement.findFirst({ where: { id: req.params.id, userId: req.dbUserId! }, select: { documentS3Key: true } });
    if (!s?.documentS3Key) return res.status(404).json({ error: 'No file on this statement.' });
    res.json({ url: await getSignedDocumentUrl(s.documentS3Key) });
  } catch (err) { next(err); }
});

router.delete('/statements/:id', async (req, res, next) => {
  try {
    const statement = await db.reconciliationStatement.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!statement) return res.status(404).json({ error: 'Statement not found' });
    if (statement.status === 'APPLIED') {
      return res.status(400).json({ error: 'Cannot delete an applied statement — it has real payment records tied to it.' });
    }
    await db.reconciliationStatement.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
