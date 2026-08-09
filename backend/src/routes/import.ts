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

// ── Analyze: parse PDFs, stream results back via SSE ─────────────────────────
// Each bill is sent as soon as it finishes parsing — no waiting for the batch.

router.post('/analyze', async (req: Request, res: Response) => {
  const userId = req.dbUserId!;
  const { files, method } = req.body as { files: { name: string; data: string }[]; method?: 'ai' | 'regex' };

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }
  if (files.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 files per import' });
  }

  // SSE headers — keep connection open while Claude processes each file
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering on Render
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  console.log(`[Import] Streaming analysis of ${files.length} PDF(s) for user ${userId}`);

  try {
    // Process ALL files in parallel — each streams its result the moment it's done
    await Promise.all(
      files.map(async (f) => {
        const buffer = Buffer.from(f.data, 'base64');
        const result = await parseBill(buffer, f.name, userId, method === 'regex' ? 'regex' : 'ai');
        send({ type: 'bill', ...result });
      })
    );

    // After all files done, send the accounts list for the dropdowns
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

    send({ type: 'done', properties });
  } catch (err) {
    console.error('[Import] Analyze error:', err);
    send({ type: 'error', message: 'Failed to analyze one or more PDFs' });
  } finally {
    res.end();
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

    // Dedup maps — keyed by normalized address / `propertyId:providerName`
    // so multiple statements for the same new property/account don't create duplicates
    const createdProperties: Record<string, string> = {};  // addrKey → propertyId
    const createdAccounts:   Record<string, string> = {};  // `${propId}:${provider}` → accountId

    const addrKey = (np: NewPropertyPayload) =>
      `${np.address}|${np.city}|${np.state}`.toLowerCase().replace(/\s+/g, ' ').trim();
    const acctKey = (propId: string, providerName: string) =>
      `${propId}:${providerName.toLowerCase().trim()}`;

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

          // Dedup: reuse account created earlier in this batch
          const key = acctKey(existingProp.id, na.providerName);
          if (createdAccounts[key]) {
            utilityAccountId = createdAccounts[key];
          } else {
            // Also check DB for an account that already exists with same provider
            const existingAcct = await db.utilityAccount.findFirst({
              where: { propertyId: existingProp.id, providerName: { equals: na.providerName, mode: 'insensitive' } },
              select: { id: true },
            });
            if (existingAcct) {
              utilityAccountId = existingAcct.id;
              createdAccounts[key] = existingAcct.id;
            } else {
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
              createdAccounts[key] = acct.id;
              console.log(`[Import] Created account ${acct.id} on existing property ${existingProp.id}`);
            }
          }
          propertyId = existingProp.id;
        }

        // ── Auto-create property + account if requested ────────────────────
        if (!utilityAccountId && item.newProperty && item.newAccount) {
          const np = item.newProperty;
          const na = item.newAccount;

          // Dedup property: reuse one created earlier in this batch
          const pKey = addrKey(np);
          if (createdProperties[pKey]) {
            propertyId = createdProperties[pKey];
          } else {
            // Also check DB for an existing property with the same address
            const existingProp = await db.property.findFirst({
              where: {
                userId,
                address: { equals: np.address, mode: 'insensitive' },
                city:    { equals: np.city,    mode: 'insensitive' },
              },
              select: { id: true },
            });
            if (existingProp) {
              propertyId = existingProp.id;
              createdProperties[pKey] = existingProp.id;
            } else {
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
              createdProperties[pKey] = prop.id;
              console.log(`[Import] Created property ${prop.id}`);
            }
          }

          // Dedup account on that property
          const aKey = acctKey(propertyId, na.providerName);
          if (createdAccounts[aKey]) {
            utilityAccountId = createdAccounts[aKey];
          } else {
            const existingAcct = await db.utilityAccount.findFirst({
              where: { propertyId, providerName: { equals: na.providerName, mode: 'insensitive' } },
              select: { id: true },
            });
            if (existingAcct) {
              utilityAccountId = existingAcct.id;
              createdAccounts[aKey] = existingAcct.id;
            } else {
              const acct = await db.utilityAccount.create({
                data: {
                  propertyId,
                  providerName: na.providerName,
                  providerSlug: na.providerSlug,
                  category:     (na.category as any) || 'OTHER',
                  accountNumber: na.accountNumber ? na.accountNumber.slice(-4) : null,
                },
              });
              utilityAccountId = acct.id;
              createdAccounts[aKey] = acct.id;
              console.log(`[Import] Created account ${acct.id} on property ${propertyId}`);
            }
          }
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
        const filenameDate   = parseDateFromFilename(item.filename);
        const hasReliableDate = !!(ex.statementDate || filenameDate);
        const statementDate  = ex.statementDate
          ? new Date(ex.statementDate)
          : (filenameDate ?? new Date());

        // Infer billing period from statement month when not extracted (e.g. management fees)
        const billingPeriodStart = ex.billingPeriodStart
          ? new Date(ex.billingPeriodStart)
          : new Date(statementDate.getFullYear(), statementDate.getMonth(), 1);
        const billingPeriodEnd = ex.billingPeriodEnd
          ? new Date(ex.billingPeriodEnd)
          : new Date(statementDate.getFullYear(), statementDate.getMonth() + 1, 0);

        if (isNaN(statementDate.getTime())) {
          errors.push(`${item.filename}: invalid statement date`);
          continue;
        }

        // Same-month dedup only when we have a reliable date (extracted or from filename).
        // Without one, all statements default to today — skipping dedup prevents false
        // "already exists" collisions when importing multiple undated statements at once.
        let existing = null;
        if (hasReliableDate) {
          const monthStart = new Date(statementDate.getFullYear(), statementDate.getMonth(), 1);
          const monthEnd   = new Date(statementDate.getFullYear(), statementDate.getMonth() + 1, 0, 23, 59, 59);
          existing = await db.statement.findFirst({
            where: { utilityAccountId, statementDate: { gte: monthStart, lte: monthEnd } },
          });
        }

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
          // Overwrite with better data from the new extraction
          await db.statement.update({
            where: { id: existing.id },
            data: {
              statementDate,
              dueDate:            ex.dueDate ? new Date(ex.dueDate) : existing.dueDate,
              billingPeriodStart,
              billingPeriodEnd,
              amountDue:      ex.amountDue      ?? existing.amountDue,
              balance:        ex.amountDue      ?? existing.balance,
              penaltiesFees:  ex.lateFee         ?? existing.penaltiesFees,
              pastDueCarried: ex.previousBalance ?? existing.pastDueCarried,
              usageValue:  ex.usageValue ?? existing.usageValue,
              usageUnit:   ex.usageUnit  ?? existing.usageUnit,
              ratePlan:    ex.ratePlan   ?? existing.ratePlan,
              rawDataJson: buildRawData(ex) as Prisma.InputJsonValue,
              ...(pdfS3Key ? { pdfS3Key } : {}),
            },
          });
          skipped++;
        } else {
          await db.statement.create({
            data: {
              utilityAccountId,
              statementDate,
              dueDate:            ex.dueDate ? new Date(ex.dueDate) : null,
              billingPeriodStart,
              billingPeriodEnd,
              amountDue:      ex.amountDue      ?? null,
              balance:        ex.amountDue      ?? null,
              amountPaid:     ex.isPaid ? (ex.amountDue ?? null) : null,
              penaltiesFees:  ex.lateFee         ?? null,
              pastDueCarried: ex.previousBalance ?? null,
              usageValue:  ex.usageValue ?? null,
              usageUnit:   ex.usageUnit  ?? null,
              ratePlan:    ex.ratePlan   ?? null,
              pdfS3Key:    pdfS3Key      ?? null,
              sourceType:  'MANUAL',
              rawDataJson: buildRawData(ex) as Prisma.InputJsonValue,
            },
          });
          imported++;
        }

        // If this statement shows paymentsReceived > 0, the prior statement was paid.
        // Find the most recent prior statement with no amountPaid and mark it paid.
        if (ex.paymentsReceived && ex.paymentsReceived > 0) {
          const priorStmt = await db.statement.findFirst({
            where: {
              utilityAccountId,
              statementDate: { lt: statementDate },
              amountPaid: null,
            },
            orderBy: { statementDate: 'desc' },
          });
          if (priorStmt && priorStmt.amountDue != null) {
            const priorDue = Number(priorStmt.amountDue);
            if (ex.paymentsReceived >= priorDue - 0.01) {
              await db.statement.update({
                where: { id: priorStmt.id },
                data: { amountPaid: priorDue },
              });
            }
          }
        }
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

/** Try to parse a date from the filename, e.g. "7-8-26" → 2026-07-08 */
function parseDateFromFilename(filename: string): Date | null {
  const name = filename.replace(/\.[^.]+$/, '');
  // M-D-YY or MM-DD-YY or M-D-YYYY
  const m = name.match(/^(\d{1,2})[-_](\d{1,2})[-_](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const d = new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
    if (!isNaN(d.getTime()) && d.getFullYear() >= 2000) return d;
  }
  return null;
}

function buildRawData(ex: ExtractedBillData): Record<string, unknown> {
  return {
    source:           'pdf_import',
    providerName:     ex.providerName,
    serviceAddress:   ex.serviceAddress,
    accountNumber:    ex.accountNumber,
    previousBalance:  ex.previousBalance,
    paymentsReceived: ex.paymentsReceived,
    currentCharges:   ex.currentCharges,
    lateFee:          ex.lateFee,
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
