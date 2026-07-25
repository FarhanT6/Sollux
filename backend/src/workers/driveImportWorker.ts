import { Worker, Job } from 'bullmq';
import { google, drive_v3 } from 'googleapis';
import { Prisma } from '@prisma/client';
import { redisConnection } from './queues';
import { db } from '../config/db';
import { parseBill } from '../services/pdfImportService';
import { uploadDocument, buildStatementKey } from '../services/s3Service';

interface DriveImportJobData {
  jobId: string;
  tokenId: string;
  folderId?: string;
  fileIds?: string[];
  userId: string;
}

const UTILITY_TYPE_TO_CATEGORY: Record<string, string> = {
  electric: 'ELECTRIC',
  gas: 'GAS',
  water: 'WATER',
  sewer: 'SEWER',
  trash: 'TRASH',
  solar: 'SOLAR',
  internet: 'INTERNET',
  phone: 'PHONE',
  other: 'OTHER',
};

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.DRIVE_REDIRECT_URI
  );
}

async function getDriveClient(tokenId: string) {
  const token = await db.driveToken.findUnique({ where: { id: tokenId } });
  if (!token) throw new Error('Drive token not found');

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiresAt.getTime(),
  });
  oauth2Client.on('tokens', async (newTokens) => {
    try {
      await db.driveToken.update({
        where: { id: token.id },
        data: {
          accessToken: newTokens.access_token || token.accessToken,
          ...(newTokens.refresh_token && { refreshToken: newTokens.refresh_token }),
          ...(newTokens.expiry_date && { expiresAt: new Date(newTokens.expiry_date) }),
        },
      });
    } catch { /* best-effort */ }
  });

  return google.drive({ version: 'v3', auth: oauth2Client });
}

// Walk every subfolder under the given folder and return all PDFs found.
async function listPdfsRecursive(drive: drive_v3.Drive, rootFolderId: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  const stack = [rootFolderId];

  while (stack.length) {
    const current = stack.pop()!;
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${current}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 200,
        pageToken,
      });
      for (const f of res.data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          stack.push(f.id!);
        } else if (f.mimeType === 'application/pdf') {
          out.push({ id: f.id!, name: f.name || 'untitled.pdf' });
        }
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  }

  return out;
}

async function downloadFile(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data as ArrayBuffer);
}

function buildRawData(ex: Awaited<ReturnType<typeof parseBill>>['extracted']) {
  return {
    source: 'drive_import',
    providerName: ex.providerName,
    serviceAddress: ex.serviceAddress,
    accountNumber: ex.accountNumber,
    previousBalance: ex.previousBalance,
    paymentsReceived: ex.paymentsReceived,
    currentCharges: ex.currentCharges,
    isPaid: ex.isPaid,
    utilityType: ex.utilityType,
    chargeBreakdown: ex.chargeBreakdown,
    alerts: ex.alerts,
    ratePlan: ex.ratePlan,
  };
}

const worker = new Worker<DriveImportJobData>(
  'drive-import',
  async (job: Job<DriveImportJobData>) => {
    const { jobId, tokenId, folderId, fileIds, userId } = job.data;
    console.log(`[DriveImportWorker] Starting job ${jobId} for user ${userId}`);

    const needsReview: any[] = [];
    let autoImported = 0;
    let processed = 0;
    const errors: string[] = [];

    try {
      const drive = await getDriveClient(tokenId);
      const collected: { id: string; name: string }[] = [];
      if (folderId) {
        collected.push(...await listPdfsRecursive(drive, folderId));
      }
      if (fileIds?.length) {
        for (const id of fileIds) {
          try {
            const meta = await drive.files.get({ fileId: id, fields: 'id, name, mimeType' });
            if (meta.data.mimeType === 'application/pdf') {
              collected.push({ id: meta.data.id!, name: meta.data.name || 'untitled.pdf' });
            }
          } catch (e: any) {
            errors.push(`Could not fetch file ${id}: ${e.message}`);
          }
        }
      }
      // Dedupe in case a picked file also sat inside a picked folder.
      const seen = new Set<string>();
      const files = collected.filter(f => !seen.has(f.id) && seen.add(f.id));

      await db.driveImportJob.update({ where: { id: jobId }, data: { totalFiles: files.length } });

      for (const file of files) {
        try {
          const buffer = await downloadFile(drive, file.id);
          const parsed = await parseBill(buffer, file.name, userId);
          const { extracted: ex, match } = parsed;

          let utilityAccountId = match.utilityAccountId;
          let autoCreated = false;

          // Property matched but this utility doesn't have an account yet — create it
          // using the AI-detected type (electric/water/gas/etc.) and provider name.
          if (!utilityAccountId && match.method === 'property_exists_no_account' && match.propertyId) {
            const acct = await db.utilityAccount.create({
              data: {
                propertyId: match.propertyId,
                providerName: ex.providerName || 'Unknown provider',
                providerSlug: toSlug(ex.providerName || 'unknown'),
                category: (UTILITY_TYPE_TO_CATEGORY[ex.utilityType] || 'OTHER') as any,
                accountNumber: ex.accountNumber ? ex.accountNumber.slice(-4) : null,
              },
            });
            utilityAccountId = acct.id;
            autoCreated = true;
            console.log(`[DriveImportWorker] Auto-created ${ex.utilityType} account ${acct.id} on property ${match.propertyId}`);
          }

          if (utilityAccountId && (match.confidence === 'high' || autoCreated)) {
            const acct = await db.utilityAccount.findUnique({
              where: { id: utilityAccountId },
              select: { id: true, propertyId: true },
            });
            if (!acct) throw new Error('account disappeared mid-import');

            const parsedDate = ex.statementDate ? new Date(ex.statementDate) : new Date();
            const statementDate = isNaN(parsedDate.getTime()) ? new Date() : parsedDate;

            const monthStart = new Date(statementDate.getFullYear(), statementDate.getMonth(), 1);
            const monthEnd = new Date(statementDate.getFullYear(), statementDate.getMonth() + 1, 0, 23, 59, 59);
            const existing = await db.statement.findFirst({
              where: { utilityAccountId: acct.id, statementDate: { gte: monthStart, lte: monthEnd } },
            });

            const key = buildStatementKey(userId, acct.propertyId, acct.id, statementDate, sanitizeFilename(file.name));
            const pdfS3Key = await uploadDocument(key, buffer);
            const rawData = buildRawData(ex);

            if (existing) {
              await db.statement.update({
                where: { id: existing.id },
                data: {
                  dueDate: ex.dueDate ? new Date(ex.dueDate) : existing.dueDate,
                  billingPeriodStart: ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : existing.billingPeriodStart,
                  billingPeriodEnd: ex.billingPeriodEnd ? new Date(ex.billingPeriodEnd) : existing.billingPeriodEnd,
                  amountDue: ex.amountDue ?? existing.amountDue,
                  usageValue: ex.usageValue ?? existing.usageValue,
                  usageUnit: ex.usageUnit ?? existing.usageUnit,
                  ratePlan: ex.ratePlan ?? existing.ratePlan,
                  rawDataJson: rawData as Prisma.InputJsonValue,
                  ...(pdfS3Key && !existing.pdfS3Key ? { pdfS3Key } : {}),
                },
              });
            } else {
              await db.statement.create({
                data: {
                  utilityAccountId: acct.id,
                  statementDate,
                  dueDate: ex.dueDate ? new Date(ex.dueDate) : null,
                  billingPeriodStart: ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : null,
                  billingPeriodEnd: ex.billingPeriodEnd ? new Date(ex.billingPeriodEnd) : null,
                  amountDue: ex.amountDue ?? null,
                  balance: ex.amountDue ?? null,
                  amountPaid: ex.isPaid ? (ex.amountDue ?? null) : null,
                  usageValue: ex.usageValue ?? null,
                  usageUnit: ex.usageUnit ?? null,
                  ratePlan: ex.ratePlan ?? null,
                  pdfS3Key,
                  sourceType: 'MANUAL',
                  rawDataJson: rawData as Prisma.InputJsonValue,
                },
              });
            }

            autoImported++;
          } else {
            // Ambiguous — stage the PDF and hand it to the normal Import Bills review flow.
            const pendingKey = `pending-review/${userId}/${jobId}/${sanitizeFilename(file.name)}`;
            await uploadDocument(pendingKey, buffer);
            needsReview.push({ filename: file.name, s3Key: pendingKey, extracted: ex, match });
          }
        } catch (fileErr) {
          errors.push(`${file.name}: ${fileErr instanceof Error ? fileErr.message : 'unknown error'}`);
        }

        processed++;
        await db.driveImportJob.update({ where: { id: jobId }, data: { processedFiles: processed } });
      }

      await db.driveImportJob.update({
        where: { id: jobId },
        data: {
          status: errors.length > 0 ? 'PARTIAL' : 'SUCCESS',
          autoImported,
          needsReviewJson: needsReview as Prisma.InputJsonValue,
          errorLog: errors.length ? errors.join('\n') : null,
          finishedAt: new Date(),
        },
      });

      console.log(`[DriveImportWorker] Job ${jobId} done: ${autoImported} auto-imported, ${needsReview.length} need review, ${errors.length} errors`);
    } catch (err) {
      console.error(`[DriveImportWorker] Job ${jobId} failed:`, err);
      await db.driveImportJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', errorLog: err instanceof Error ? err.message : 'unknown error', finishedAt: new Date() },
      });
    }
  },
  { connection: redisConnection, concurrency: 1 }
);

worker.on('completed', job => console.log(`[DriveImportWorker] Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`[DriveImportWorker] Job ${job?.id} failed:`, err.message));

export default worker;
