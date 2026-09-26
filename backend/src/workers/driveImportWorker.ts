import { Worker, Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { google, drive_v3 } from 'googleapis';
import { guardWorker } from './redisGuard';
import { createWorkerConnection, workerTuning } from './queues';
import { db } from '../config/db';
import { intakeBill } from '../services/documentIntake';

interface DriveImportJobData {
  jobId: string;
  tokenId: string;
  folderId?: string;
  fileIds?: string[];
  userId: string;
  /** Omitted on jobs queued before this was threaded through — treated as regex. */
  method?: 'ai' | 'regex';
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

const worker = new Worker<DriveImportJobData>(
  'drive-import',
  async (job: Job<DriveImportJobData>) => {
    console.log(`[DriveImportWorker] Received job ${job.id}`);

    const { jobId, tokenId, folderId, fileIds, userId, method } = job.data;
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
          const r = await intakeBill(buffer, file.name, userId, method === 'ai' ? 'ai' : 'regex', jobId, 'drive_import');
          if (r.outcome === 'filed') autoImported++;
          else if (r.outcome === 'review') needsReview.push(r.reviewItem);
          else if (r.outcome === 'error') errors.push(r.error);
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
  { connection: createWorkerConnection(), concurrency: 1, ...workerTuning }
);

worker.on('completed', job => console.log(`[DriveImportWorker] Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`[DriveImportWorker] Job ${job?.id} failed:`, err.message));
guardWorker('DriveImportWorker', worker);

export default worker;
