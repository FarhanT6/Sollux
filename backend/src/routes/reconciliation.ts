import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument } from '../services/s3Service';

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
        const itemDate = item.date ? new Date(item.date) : statement.statementDate;

        if (item.type === 'RENT' && item.targetId) {
          const p = await tx.rentPayment.create({
            data: {
              leaseId: item.targetId,
              periodDate,
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
        } else if (item.type === 'EXPENSE' && profile.propertyId) {
          const e = await tx.expense.create({
            data: {
              propertyId: profile.propertyId,
              category: (profile.managementFeeCategory ?? 'PROPERTY_MANAGEMENT') as any,
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
