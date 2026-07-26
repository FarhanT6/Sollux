/**
 * POST /api/import/analyze  — Parse PDFs and return extracted data for review
 * POST /api/import/confirm  — Save confirmed statements (creates properties/accounts as needed)
 */
import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { parseBill, ExtractedBillData, MatchResult } from '../services/pdfImportService';
import { uploadDocument, buildStatementKey } from '../services/s3Service';
import { attachDbUser } from '../middleware/requireAuth';
import { db } from '../config/db';

const router = Router();

// All import routes need the DB user
router.use(attachDbUser);

// ── Accounts refresh — called when user creates a new account mid-review ──────
router.get('/accounts', async (req: Request, res: Response) => {
  try {
    const properties = await db.property.findMany({
      where: { userId: req.dbUserId! },
      include: {
        utilityAccounts: {
          select: { id: true, providerName: true, category: true },
          orderBy: { providerName: 'asc' },
        },
      },
      orderBy: { address: 'asc' },
    });
    return res.json({ properties });
  } catch (err) {
    console.error('[Import] Accounts refresh error:', err);
    return res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// ── Analyze: parse PDFs, return extracted data + match suggestions ────────────

router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const userId = req.dbUserId!;
    const { files } = req.body as { files: { name: string; data: string }[] };

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }
    if (files.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 files per import' });
    }

    console.log(`[Import] Analyzing ${files.length} PDF(s) for user ${userId}`);

    // Process in parallel batches of 5 to avoid rate limits
    const results = [];
    for (let i = 0; i < files.length; i += 5) {
      const batch = files.slice(i, i + 5);
      const batchResults = await Promise.all(
        batch.map(async (f) => {
          const buffer = Buffer.from(f.data, 'base64');
          return parseBill(buffer, f.name, userId);
        })
      );
      results.push(...batchResults);
    }

    // Fetch all user properties + their utility accounts for the dropdown
    const properties = await db.property.findMany({
      where: { userId },
      include: {
        utilityAccounts: {
          select: { id: true, providerName: true, category: true },
          orderBy: { providerName: 'asc' },
        },
      },
      orderBy: { address: 'asc' },
    });

    return res.json({ bills: results, properties });
  } catch (err) {
    console.error('[Import] Analyze error:', err);
    return res.status(500).json({ error: 'Failed to analyze PDFs' });
  }
});

// ── Confirm: save reviewed statements ────────────────────────────────────────

interface NewPropertyPayload {
  address:  string;
  city:     string;
  state:    string;
  zip:      string;
  nickname: string;
  type:     string;
}

interface NewAccountPayload {
  providerName:  string;
  providerSlug:  string;
  category:      string;
  accountNumber: string;
}

interface ConfirmItem {
  filename:         string;
  fileData:         string;           // base64 PDF
  extracted:        ExtractedBillData;
  match:            MatchResult;
  utilityAccountId: string | null;    // existing account OR null if creating new
  propertyId?:      string | null;    // existing property to add a new account to
  newProperty?:     NewPropertyPayload;
  newAccount?:      NewAccountPayload;
}

router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const userId = req.dbUserId!;
    const { items } = req.body as { items: ConfirmItem[] };

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items to confirm' });
    }

    let imported = 0;
    let skipped  = 0;
    const errors: string[] = [];

    for (const item of items) {
      try {
        let utilityAccountId = item.utilityAccountId;
        let propertyId: string | null = null;

        // ── Add new account to existing property ──────────────────────────
        if (!utilityAccountId && item.propertyId && item.newAccount && !item.newProperty) {
          const na = item.newAccount;

          // Verify property belongs to user
          const existingProp = await db.property.findUnique({
            where: { id: item.propertyId },
            select: { id: true, userId: true },
          });
          if (!existingProp || existingProp.userId !== userId) {
            errors.push(`${item.filename}: property not found or access denied`);
            continue;
          }

          const acct = await db.utilityAccount.create({
            data: {
              propertyId:    existingProp.id,
              providerName:  na.providerName,
              providerSlug:  na.providerSlug,
              category:      (na.category as any) || 'OTHER',
              accountNumber: na.accountNumber ? na.accountNumber.slice(-4) : null,
            },
          });
          utilityAccountId = acct.id;
          propertyId = existingProp.id;
          console.log(`[Import] Created account ${acct.id} on existing property ${existingProp.id}`);
        }

        // ── Auto-create property + account if requested ────────────────────
        if (!utilityAccountId && item.newProperty && item.newAccount) {
          const np = item.newProperty;
          const na = item.newAccount;

          // Create property
          const prop = await db.property.create({
            data: {
              userId,
              address:  np.address,
              city:     np.city,
              state:    np.state,
              zip:      np.zip || '00000',
              nickname: np.nickname || null,
              type:     (np.type as any) || 'RENTAL',
            },
          });
          propertyId = prop.id;

          // Create utility account
          const acct = await db.utilityAccount.create({
            data: {
              propertyId:   prop.id,
              providerName: na.providerName,
              providerSlug: na.providerSlug,
              category:     (na.category as any) || 'OTHER',
              accountNumber: na.accountNumber ? na.accountNumber.slice(-4) : null,
            },
          });
          utilityAccountId = acct.id;
          console.log(`[Import] Created property ${prop.id} + account ${acct.id}`);
        }

        if (!utilityAccountId) {
          errors.push(`${item.filename}: no utility account selected`);
          continue;
        }

        // Verify the account belongs to this user
        const acct = await db.utilityAccount.findUnique({
          where: { id: utilityAccountId },
          include: { property: { select: { id: true, userId: true } } },
        });

        if (!acct || acct.property.userId !== userId) {
          errors.push(`${item.filename}: account not found or access denied`);
          continue;
        }

        const ex = item.extracted;
        const statementDate = ex.statementDate ? new Date(ex.statementDate) : new Date();
        if (isNaN(statementDate.getTime())) {
          errors.push(`${item.filename}: invalid statement date`);
          continue;
        }

        // Same-month dedup check
        const monthStart = new Date(statementDate.getFullYear(), statementDate.getMonth(), 1);
        const monthEnd   = new Date(statementDate.getFullYear(), statementDate.getMonth() + 1, 0, 23, 59, 59);
        const existing   = await db.statement.findFirst({
          where: { utilityAccountId, statementDate: { gte: monthStart, lte: monthEnd } },
        });

        // Upload PDF to S3
        let pdfS3Key: string | undefined;
        if (item.fileData) {
          const buf = Buffer.from(item.fileData, 'base64');
          const key = buildStatementKey(
            userId,
            acct.property.id,
            acct.id,
            statementDate,
            sanitizeFilename(item.filename),
          );
          pdfS3Key = await uploadDocument(key, buf);
        }

        if (existing) {
          // Update with better data + PDF if we now have one
          await db.statement.update({
            where: { id: existing.id },
            data: {
              dueDate:            ex.dueDate            ? new Date(ex.dueDate)            : existing.dueDate,
              billingPeriodStart: ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : existing.billingPeriodStart,
              billingPeriodEnd:   ex.billingPeriodEnd   ? new Date(ex.billingPeriodEnd)   : existing.billingPeriodEnd,
              amountDue:          ex.amountDue          ?? existing.amountDue,
              usageValue:         ex.usageValue         ?? existing.usageValue,
              usageUnit:          ex.usageUnit          ?? existing.usageUnit,
              ratePlan:           ex.ratePlan           ?? existing.ratePlan,
              rawDataJson:        buildRawData(ex)      as Prisma.InputJsonValue,
              ...(pdfS3Key && !existing.pdfS3Key ? { pdfS3Key } : {}),
            },
          });
          skipped++;
          continue;
        }

        await db.statement.create({
          data: {
            utilityAccountId,
            statementDate,
            dueDate:            ex.dueDate            ? new Date(ex.dueDate)            : null,
            billingPeriodStart: ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : null,
            billingPeriodEnd:   ex.billingPeriodEnd   ? new Date(ex.billingPeriodEnd)   : null,
            amountDue:          ex.amountDue          ?? null,
            balance:            ex.amountDue          ?? null,
            amountPaid:         ex.isPaid             ? (ex.amountDue ?? null) : null,
            usageValue:         ex.usageValue         ?? null,
            usageUnit:          ex.usageUnit          ?? null,
            ratePlan:           ex.ratePlan           ?? null,
            pdfS3Key:           pdfS3Key              ?? null,
            sourceType:         'MANUAL',
            rawDataJson:        buildRawData(ex)      as Prisma.InputJsonValue,
          },
        });
        imported++;
      } catch (err) {
        errors.push(`${item.filename}: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }

    return res.json({ imported, skipped, errors });
  } catch (err) {
    console.error('[Import] Confirm error:', err);
    return res.status(500).json({ error: 'Failed to save statements' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRawData(ex: ExtractedBillData): Record<string, unknown> {
  return {
    source:           'pdf_import',
    providerName:     ex.providerName,
    serviceAddress:   ex.serviceAddress,
    accountNumber:    ex.accountNumber,
    previousBalance:  ex.previousBalance,
    paymentsReceived: ex.paymentsReceived,
    currentCharges:   ex.currentCharges,
    isPaid:           ex.isPaid,
    utilityType:      ex.utilityType,
    chargeBreakdown:  ex.chargeBreakdown,
    alerts:           ex.alerts,
    ratePlan:         ex.ratePlan,
  };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export default router;
