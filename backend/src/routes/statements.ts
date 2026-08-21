import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { getSignedDocumentUrl } from '../services/s3Service';

const router = Router();
router.use(attachDbUser);

// GET /api/statements?utilityAccountId=xxx&propertyId=xxx
router.get('/', async (req, res, next) => {
  try {
    const { utilityAccountId, propertyId } = req.query;

    const where: any = {};

    if (utilityAccountId) {
      // Verify access
      const account = await db.utilityAccount.findFirst({
        where: { id: String(utilityAccountId), property: { userId: req.dbUserId! } },
      });
      if (!account) return res.status(404).json({ error: 'Utility account not found' });
      where.utilityAccountId = String(utilityAccountId);
    } else if (propertyId) {
      const property = await db.property.findFirst({
        where: { id: String(propertyId), userId: req.dbUserId! },
      });
      if (!property) return res.status(404).json({ error: 'Property not found' });
      where.utilityAccount = { propertyId: String(propertyId) };
    } else {
      const userProperties = await db.property.findMany({
        where: { userId: req.dbUserId! },
        select: { id: true },
      });
      where.utilityAccount = { propertyId: { in: userProperties.map(p => p.id) } };
    }

    const statements = await db.statement.findMany({
      where,
      orderBy: { statementDate: 'desc' },
      // A property with several accounts and years of history passes 100
      // easily; the callers use this to compute property-level totals.
      take: 1000,
      include: {
        utilityAccount: {
          select: { providerName: true, category: true, property: { select: { address: true, nickname: true } } },
        },
      },
    });

    res.json(statements);
  } catch (err) {
    next(err);
  }
});

// ── Line-item summary (fees, amounts due, past due, paid) ──────────────────
// Returns one resolved row per statement, ready for the frontend to pivot
// by month/year/all-time and by provider/property however it wants — a
// user's whole statement history is small enough (low thousands of rows at
// most) that shipping it flat and aggregating client-side is simpler than a
// rigid set of server-side grouping options.

const FEE_KEYS = ['penalties', 'lateFee', 'afterDueDateAmt'];
const PAST_DUE_KEYS = ['pastDue', 'previousBalance'];
const CHARGES_EXCL_FEES_KEYS = ['currentCharges'];

function firstNumeric(raw: Record<string, unknown> | null | undefined, keys: string[]): number | null {
  if (!raw) return null;
  for (const k of keys) {
    const v = raw[k];
    if (v != null && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

// GET /api/statements/summary?propertyId=&utilityAccountId=
router.get('/summary', async (req, res, next) => {
  try {
    const { propertyId, utilityAccountId } = req.query;

    const where: any = {};
    if (utilityAccountId) {
      const account = await db.utilityAccount.findFirst({
        where: { id: String(utilityAccountId), property: { userId: req.dbUserId! } },
      });
      if (!account) return res.status(404).json({ error: 'Utility account not found' });
      where.utilityAccountId = String(utilityAccountId);
    } else if (propertyId) {
      const property = await db.property.findFirst({ where: { id: String(propertyId), userId: req.dbUserId! } });
      if (!property) return res.status(404).json({ error: 'Property not found' });
      where.utilityAccount = { propertyId: String(propertyId) };
    } else {
      const userProperties = await db.property.findMany({ where: { userId: req.dbUserId! }, select: { id: true } });
      where.utilityAccount = { propertyId: { in: userProperties.map(p => p.id) } };
    }

    const statements = await db.statement.findMany({
      where,
      orderBy: { statementDate: 'desc' },
      include: {
        utilityAccount: {
          select: {
            id: true, providerName: true, category: true,
            property: { select: { id: true, address: true, nickname: true } },
          },
        },
      },
    });

    const rows = statements.map(s => {
      const raw = s.rawDataJson as Record<string, unknown> | null;
      const amountDue = s.amountDue != null ? Number(s.amountDue) : null;
      const pastDueCarried = s.pastDueCarried != null ? Number(s.pastDueCarried) : firstNumeric(raw, PAST_DUE_KEYS);
      return {
        id: s.id,
        statementDate: s.statementDate,
        dueDate: s.dueDate,
        amountDue,
        amountPaid: s.amountPaid != null ? Number(s.amountPaid) : null,
        chargesExcludingFees: s.chargesExcludingFees != null ? Number(s.chargesExcludingFees) : firstNumeric(raw, CHARGES_EXCL_FEES_KEYS),
        penaltiesFees: s.penaltiesFees != null ? Number(s.penaltiesFees) : firstNumeric(raw, FEE_KEYS),
        pastDueCarried,
        totalDueWithPastDue: amountDue != null || pastDueCarried != null ? (amountDue ?? 0) + (pastDueCarried ?? 0) : null,
        notes: s.notes,
        utilityAccountId: s.utilityAccount.id,
        providerName: s.utilityAccount.providerName,
        category: s.utilityAccount.category,
        propertyId: s.utilityAccount.property.id,
        propertyLabel: s.utilityAccount.property.nickname || s.utilityAccount.property.address,
      };
    });

    res.json(rows);
  } catch (err) { next(err); }
});

const StatementSchema = z.object({
  utilityAccountId: z.string(),
  statementDate: z.string().transform(s => new Date(s)),
  dueDate: z.string().optional().nullable().transform(s => (s ? new Date(s) : null)),
  amountDue: z.number().optional().nullable(),
  amountPaid: z.number().optional().nullable(),
  chargesExcludingFees: z.number().optional().nullable(),
  penaltiesFees: z.number().optional().nullable(),
  pastDueCarried: z.number().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// POST /api/statements — manual entry (no PDF required)
router.post('/', async (req, res, next) => {
  try {
    const data = StatementSchema.parse(req.body);
    const account = await db.utilityAccount.findFirst({
      where: { id: data.utilityAccountId, property: { userId: req.dbUserId! } },
    });
    if (!account) return res.status(404).json({ error: 'Utility account not found' });

    const statement = await db.statement.create({
      data: {
        utilityAccountId: data.utilityAccountId,
        statementDate: data.statementDate,
        dueDate: data.dueDate,
        amountDue: data.amountDue ?? null,
        balance: data.amountDue ?? null,
        amountPaid: data.amountPaid ?? null,
        chargesExcludingFees: data.chargesExcludingFees ?? null,
        penaltiesFees: data.penaltiesFees ?? null,
        pastDueCarried: data.pastDueCarried ?? null,
        notes: data.notes ?? null,
        sourceType: 'MANUAL',
      },
    });
    res.status(201).json(statement);
  } catch (err) { next(err); }
});

// PATCH /api/statements/:id — update any editable field (amountPaid, fees, etc.)
router.patch('/:id', async (req, res, next) => {
  try {
    const statement = await db.statement.findFirst({
      where: { id: req.params.id, utilityAccount: { property: { userId: req.dbUserId! } } },
    });
    if (!statement) return res.status(404).json({ error: 'Statement not found' });

    const data = StatementSchema.omit({ utilityAccountId: true, statementDate: true }).extend({
      statementDate: z.string().optional().transform(s => (s ? new Date(s) : undefined)),
    }).partial().parse(req.body);

    const updated = await db.statement.update({
      where: { id: req.params.id },
      data: {
        ...(data.statementDate !== undefined && { statementDate: data.statementDate }),
        ...(data.dueDate !== undefined && { dueDate: data.dueDate }),
        ...(data.amountDue !== undefined && { amountDue: data.amountDue, balance: data.amountDue }),
        ...(data.amountPaid !== undefined && { amountPaid: data.amountPaid }),
        ...(data.chargesExcludingFees !== undefined && { chargesExcludingFees: data.chargesExcludingFees }),
        ...(data.penaltiesFees !== undefined && { penaltiesFees: data.penaltiesFees }),
        ...(data.pastDueCarried !== undefined && { pastDueCarried: data.pastDueCarried }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/statements/:id — remove a single statement (admin/cleanup use)
router.delete('/:id', async (req, res, next) => {
  try {
    const statement = await db.statement.findFirst({
      where: {
        id: req.params.id,
        utilityAccount: { property: { userId: req.dbUserId! } },
      },
    });

    if (!statement) return res.status(404).json({ error: 'Statement not found' });

    await db.statement.delete({ where: { id: statement.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/statements/:id/download — signed S3 URL for PDF
router.get('/:id/download', async (req, res, next) => {
  try {
    const statement = await db.statement.findFirst({
      where: {
        id: req.params.id,
        utilityAccount: { property: { userId: req.dbUserId! } },
      },
    });

    if (!statement) return res.status(404).json({ error: 'Statement not found' });
    if (!statement.pdfS3Key) return res.status(404).json({ error: 'No PDF available' });

    const url = await getSignedDocumentUrl(statement.pdfS3Key);
    res.json({ url, expiresIn: 3600 });
  } catch (err) {
    next(err);
  }
});

export default router;
