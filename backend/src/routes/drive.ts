import { Router } from 'express';
import { google, drive_v3 } from 'googleapis';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { getSignedDocumentUrl, downloadDocument, uploadDocument, buildStatementKey } from '../services/s3Service';
import { parseBill } from '../services/pdfImportService';
import { findOrCreateUtilityAccount } from '../services/utilityAccountResolver';

const router = Router();
// attachDbUser is applied per-route below, NOT via router.use — the /callback
// route below is hit by Google's redirect (no Clerk session cookie context
// guaranteed), so it must stay exempt.

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.DRIVE_REDIRECT_URI
  );
}

// POST /api/drive/connect — returns OAuth URL
router.post('/connect', attachDbUser, async (req, res, next) => {
  try {
    const oauth2Client = getOAuthClient();
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/drive.readonly'],
      state: req.dbUserId!,
      prompt: 'consent', // force consent so we always get a refresh token
    });
    res.json({ url });
  } catch (err) { next(err); }
});

// GET /api/drive/callback — OAuth callback (no auth middleware — Google redirects here)
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state: userId } = req.query;
    if (!code || !userId) return res.status(400).json({ error: 'Missing code or state' });

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(String(code));

    oauth2Client.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const about = await drive.about.get({ fields: 'user' });
    const email = about.data.user?.emailAddress || '';

    await db.driveToken.upsert({
      where: { userId_email: { userId: String(userId), email } },
      create: {
        userId: String(userId),
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token || '',
        expiresAt: new Date(tokens.expiry_date!),
        email,
      },
      update: {
        accessToken: tokens.access_token!,
        ...(tokens.refresh_token && { refreshToken: tokens.refresh_token }),
        expiresAt: new Date(tokens.expiry_date!),
      },
    });

    res.redirect(`${process.env.FRONTEND_URL}/settings?drive=connected&email=${encodeURIComponent(email)}`);
  } catch (err) { next(err); }
});

// GET /api/drive/status — returns all connected Drive accounts
router.get('/status', attachDbUser, async (req, res, next) => {
  try {
    const tokens = await db.driveToken.findMany({
      where: { userId: req.dbUserId! },
      select: { id: true, email: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ connected: tokens.length > 0, accounts: tokens });
  } catch (err) { next(err); }
});

// DELETE /api/drive/disconnect/:id
router.delete('/disconnect/:id', attachDbUser, async (req, res, next) => {
  try {
    const token = await db.driveToken.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
    });
    if (!token) return res.status(404).json({ error: 'Not found' });
    await db.driveToken.delete({ where: { id: token.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

async function getOAuth2ClientForToken(tokenId: string, userId: string) {
  const token = await db.driveToken.findFirst({ where: { id: tokenId, userId } });
  if (!token) throw new Error('Drive account not found');

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiresAt.getTime(),
  });

  // Persist refreshed tokens so future jobs (and future picker sessions) don't need to re-auth.
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

  return oauth2Client;
}

// GET /api/drive/access-token?tokenId= — short-lived OAuth token for the Google Picker widget.
// The picker runs client-side and needs a raw access token to list the user's own Drive
// (including "Shared with me") with the same drive.readonly access this account already granted.
router.get('/access-token', attachDbUser, async (req, res, next) => {
  try {
    const { tokenId } = req.query as { tokenId?: string };
    if (!tokenId) return res.status(400).json({ error: 'tokenId required' });

    const oauth2Client = await getOAuth2ClientForToken(tokenId, req.dbUserId!);
    const { token } = await oauth2Client.getAccessToken();
    if (!token) return res.status(500).json({ error: 'Could not obtain an access token' });

    res.json({ accessToken: token });
  } catch (err) { next(err); }
});

// ── Shared helpers for streaming import ──────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseDateFromFilename(filename: string): Date | null {
  const name = filename.replace(/\.[^.]+$/, '');
  const m = name.match(/^(\d{1,2})[-_](\d{1,2})[-_](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const d = new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
    if (!isNaN(d.getTime()) && d.getFullYear() >= 2000) return d;
  }
  return null;
}

const UTILITY_CATEGORY: Record<string, string> = {
  electric: 'ELECTRIC', gas: 'GAS', water: 'WATER', sewer: 'SEWER',
  trash: 'TRASH', solar: 'SOLAR', internet: 'INTERNET', phone: 'PHONE', other: 'OTHER',
};

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
        if (f.mimeType === 'application/vnd.google-apps.folder') stack.push(f.id!);
        else if (f.mimeType === 'application/pdf') out.push({ id: f.id!, name: f.name || 'untitled.pdf' });
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  }
  return out;
}

async function downloadDriveFile(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data as ArrayBuffer);
}

// POST /api/drive/stream — SSE endpoint: download files from Drive, run Claude, stream cards back.
// No background job, no polling, no "Review" button — cards appear as each file finishes.
router.post('/stream', attachDbUser, async (req, res) => {
  const userId = req.dbUserId!;
  const { tokenId, folderId, fileIds, method } = req.body as {
    tokenId: string; folderId?: string; fileIds?: string[]; method?: 'ai' | 'regex';
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const oauth2Client = await getOAuth2ClientForToken(tokenId, userId);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Collect all PDF files
    const collected: { id: string; name: string }[] = [];
    if (folderId) collected.push(...await listPdfsRecursive(drive, folderId));
    if (fileIds?.length) {
      for (const id of fileIds) {
        try {
          const meta = await drive.files.get({ fileId: id, fields: 'id, name, mimeType' });
          if (meta.data.mimeType === 'application/pdf') collected.push({ id: meta.data.id!, name: meta.data.name || 'untitled.pdf' });
        } catch { /* skip unreachable file */ }
      }
    }
    const seen = new Set<string>();
    const files = collected.filter(f => !seen.has(f.id) && seen.add(f.id));

    send({ type: 'total', count: files.length });

    let autoImported = 0;

    // Bounded concurrency. An unbounded Promise.all over a whole folder opens a
    // Drive download, a model call and an S3 upload for every file at once —
    // hundreds of bills means rate-limit rejections and every PDF buffer held
    // in memory simultaneously. Small batches keep both in check.
    const IMPORT_CONCURRENCY = 4;
    for (let batchStart = 0; batchStart < files.length; batchStart += IMPORT_CONCURRENCY) {
    await Promise.all(files.slice(batchStart, batchStart + IMPORT_CONCURRENCY).map(async (file) => {
      try {
        const buffer = await downloadDriveFile(drive, file.id);
        const parsed  = await parseBill(buffer, file.name, userId, method === 'regex' ? 'regex' : 'ai');
        const { extracted: ex, match } = parsed;

        let utilityAccountId = match.utilityAccountId;

        // Property matched but no account for this utility yet. Goes through
        // the resolver rather than creating directly: these files are processed
        // concurrently, and a bare create-per-file gives one account per bill.
        if (!utilityAccountId && match.method === 'property_exists_no_account' && match.propertyId) {
          const acct = await findOrCreateUtilityAccount({
            propertyId: match.propertyId,
            providerName: ex.providerName,
            category: UTILITY_CATEGORY[ex.utilityType] || 'OTHER',
            accountNumber: ex.accountNumber,
          });
          utilityAccountId = acct.id;
        }

        // High-confidence: auto-import to DB, don't need review
        if (utilityAccountId && match.confidence === 'high') {
          const acct = await db.utilityAccount.findUnique({ where: { id: utilityAccountId }, select: { id: true, propertyId: true } });
          if (acct) {
            const filenameDate  = parseDateFromFilename(file.name);
            const statementDate = ex.statementDate ? new Date(ex.statementDate) : (filenameDate ?? new Date());

            // The same bill-identity rule as /import/confirm: a bill is its
            // billing period, not its issue month. This path kept the old
            // month-based lookup after the rest of the importers moved on, and
            // it is the path Drive uploads actually take — so IID's drifting
            // cycle kept losing bills here long after the "fix" shipped. A
            // February bill issued 2 March and the March bill issued 30 March
            // share an issue month; the month lookup called them the same bill
            // and the update overwrote February with March, in place, leaving
            // the count unchanged and the loss invisible.
            let existing = null;
            if (ex.billingPeriodStart) {
              const start = new Date(ex.billingPeriodStart);
              const window = 7 * 24 * 60 * 60 * 1000;
              existing = await db.statement.findFirst({
                where: {
                  utilityAccountId: acct.id,
                  billingPeriodStart: {
                    gte: new Date(start.getTime() - window),
                    lte: new Date(start.getTime() + window),
                  },
                },
              });
            }
            if (!existing) {
              // Issue-month fallback, restricted to rows that carry no real
              // period of their own — null from this path's own create, or the
              // whole-calendar-month shape the confirm path infers. A row with
              // a genuine period is identified by that period and must never
              // be claimed by a different bill that merely shares its month.
              const monthStart = new Date(Date.UTC(statementDate.getUTCFullYear(), statementDate.getUTCMonth(), 1));
              const monthEnd   = new Date(Date.UTC(statementDate.getUTCFullYear(), statementDate.getUTCMonth() + 1, 0, 23, 59, 59));
              const DAY = 24 * 60 * 60 * 1000;
              const firstOfMonth = Date.UTC(statementDate.getUTCFullYear(), statementDate.getUTCMonth(), 1);
              existing = await db.statement.findFirst({
                where: {
                  utilityAccountId: acct.id,
                  statementDate: { gte: monthStart, lte: monthEnd },
                  OR: [
                    { billingPeriodStart: null },
                    { billingPeriodStart: { gte: new Date(firstOfMonth - DAY), lte: new Date(firstOfMonth + DAY) } },
                  ],
                },
              });
            }

            const s3Key = buildStatementKey(userId, acct.propertyId, acct.id, statementDate, sanitizeFilename(file.name));
            const pdfS3Key = await uploadDocument(s3Key, buffer);

            // Compute the breakdown: amountDue = current period charges only;
            // balance/totalDue = full amount owed including any past-due carry-forward.
            const totalDue = (ex.currentCharges != null || ex.previousBalance != null)
              ? (ex.currentCharges ?? 0) + (ex.previousBalance ?? 0)
              : ex.amountDue;
            const amountDueCurrent = ex.currentCharges ?? ex.amountDue;
            const rawData: Record<string, unknown> = {
              source: 'drive_import',
              providerName: ex.providerName,
              serviceAddress: ex.serviceAddress,
              accountNumber: ex.accountNumber,
              previousBalance: ex.previousBalance,
              paymentsReceived: ex.paymentsReceived,
              currentCharges: ex.currentCharges,
              totalDue,
              pastDue: ex.previousBalance != null && ex.previousBalance > 0 ? ex.previousBalance : undefined,
              isPaid: ex.isPaid,
              utilityType: ex.utilityType,
              chargeBreakdown: ex.chargeBreakdown,
              alerts: ex.alerts,
            };

            const pastDueAmt = ex.previousBalance != null && ex.previousBalance > 0 ? ex.previousBalance : null;
            // Prefer the actual payment amount the statement shows over
            // guessing "fully paid" from the isPaid flag.
            const amountPaidValue = ex.paymentsReceived ?? (ex.isPaid ? (totalDue ?? amountDueCurrent ?? null) : null);

            if (existing) {
              await db.statement.update({ where: { id: existing.id }, data: {
                statementDate,
                amountDue: amountDueCurrent ?? existing.amountDue,
                balance: totalDue ?? amountDueCurrent ?? existing.balance,
                amountPaid: amountPaidValue ?? existing.amountPaid,
                dueDate: ex.dueDate ? new Date(ex.dueDate) : existing.dueDate,
                chargesExcludingFees: ex.currentCharges ?? existing.chargesExcludingFees,
                penaltiesFees: ex.lateFee ?? existing.penaltiesFees,
                pastDueCarried: pastDueAmt ?? existing.pastDueCarried,
                // These were written on create but omitted on update, so a
                // re-import silently dropped the billing period and usage it
                // had just extracted. Every field the create branch sets must
                // be set here too, or the two paths disagree.
                billingPeriodStart: ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : existing.billingPeriodStart,
                billingPeriodEnd:   ex.billingPeriodEnd   ? new Date(ex.billingPeriodEnd)   : existing.billingPeriodEnd,
                usageValue: ex.usageValue ?? existing.usageValue,
                usageUnit:  ex.usageUnit  ?? existing.usageUnit,
                ratePlan:   ex.ratePlan   ?? existing.ratePlan,
                rawDataJson: rawData as Prisma.InputJsonValue,
                ...(pdfS3Key ? { pdfS3Key } : {}),
              }});
            } else {
              await db.statement.create({ data: {
                utilityAccountId: acct.id, statementDate,
                dueDate: ex.dueDate ? new Date(ex.dueDate) : null,
                billingPeriodStart: ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : null,
                billingPeriodEnd:   ex.billingPeriodEnd   ? new Date(ex.billingPeriodEnd)   : null,
                amountDue: amountDueCurrent ?? null,
                balance: totalDue ?? amountDueCurrent ?? null,
                amountPaid: amountPaidValue,
                chargesExcludingFees: ex.currentCharges ?? null,
                penaltiesFees: ex.lateFee ?? null,
                pastDueCarried: pastDueAmt,
                usageValue: ex.usageValue ?? null, usageUnit: ex.usageUnit ?? null,
                ratePlan: ex.ratePlan ?? null, pdfS3Key, sourceType: 'MANUAL',
                rawDataJson: rawData as Prisma.InputJsonValue,
              }});
            }
            autoImported++;
            send({ type: 'auto_imported', filename: file.name });
            return;
          }
        }

        // Needs review — stream full bill data so a card appears immediately
        send({ type: 'bill', ...parsed, fileData: buffer.toString('base64') });
      } catch (err) {
        send({ type: 'error', filename: file.name, message: err instanceof Error ? err.message : 'unknown error' });
      }
    }));
    }

    // Send updated properties list for the review dropdowns
    const properties = await db.property.findMany({
      where: { userId },
      include: { utilityAccounts: { select: { id: true, providerName: true, category: true, serviceLabel: true, accountNumber: true }, orderBy: { providerName: 'asc' } } },
      orderBy: { address: 'asc' },
    });
    send({ type: 'done', autoImported, properties });
  } catch (err) {
    send({ type: 'error', filename: '', message: err instanceof Error ? err.message : 'stream failed' });
  } finally {
    res.end();
  }
});

// POST /api/drive/import  { tokenId, folderId?, fileIds?, folderName? } — queues background import
// Either folderId (import everything in it recursively), fileIds (import just
// this specific list of files), or both (import that folder AND the loose files).
router.post('/import', attachDbUser, async (req, res, next) => {
  try {
    const { tokenId, folderId, fileIds, folderName, method } = req.body as {
      tokenId: string;
      folderId?: string;
      fileIds?: string[];
      folderName?: string;
      method?: 'ai' | 'regex';
    };
    if (!tokenId) return res.status(400).json({ error: 'tokenId required' });
    if (!folderId && (!fileIds || fileIds.length === 0)) {
      return res.status(400).json({ error: 'folderId or fileIds required' });
    }

    const token = await db.driveToken.findFirst({ where: { id: tokenId, userId: req.dbUserId! } });
    if (!token) return res.status(404).json({ error: 'Drive account not found' });

    const job = await db.driveImportJob.create({
      data: {
        userId: req.dbUserId!,
        driveTokenId: tokenId,
        folderName: folderName || null,
        status: 'RUNNING',
      },
    });

    const { driveImportQueue } = await import('../workers/queues');
    await driveImportQueue.add(
      'import',
      // Matches the other two entry points, which default to AI when the
      // caller says nothing. This one defaulted to text parsing to keep a bulk
      // folder import cheap — but a caller that omits the field gets the
      // cheaper, materially less accurate extractor without ever choosing it,
      // and the same reasoning is what put a silent text-parsing default in
      // front of every import for two months. Cost is a decision to make
      // explicitly, not one to make on someone's behalf by omission.
      { jobId: job.id, tokenId, folderId, fileIds, userId: req.dbUserId!, method: method === 'regex' ? 'regex' : 'ai' },
      { attempts: 1 }
    );

    res.json({ jobId: job.id });
  } catch (err) { next(err); }
});

// GET /api/drive/jobs/:id — poll progress; needsReview items get fresh signed S3 URLs
router.get('/jobs/:id', attachDbUser, async (req, res, next) => {
  try {
    const job = await db.driveImportJob.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!job) return res.status(404).json({ error: 'Not found' });

    const needsReview = (job.needsReviewJson as any[]) || [];
    const withUrls = await Promise.all(
      needsReview.map(async (item) => ({
        ...item,
        pdfUrl: await getSignedDocumentUrl(item.s3Key, 900),
      }))
    );

    res.json({
      id: job.id,
      status: job.status,
      totalFiles: job.totalFiles,
      processedFiles: job.processedFiles,
      autoImported: job.autoImported,
      needsReview: withUrls,
      errorLog: job.errorLog,
    });
  } catch (err) { next(err); }
});

// GET /api/drive/jobs/:id/review-data — streams pending PDFs via SSE so the
// browser can show bill cards as each S3 download finishes (no waiting for all).
router.get('/jobs/:id/review-data', attachDbUser, async (req, res, next) => {
  try {
    const job = await db.driveImportJob.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!job) return res.status(404).json({ error: 'Not found' });

    const needsReview = (job.needsReviewJson as any[]) || [];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    await Promise.all(
      needsReview.map(async (item) => {
        const buffer = await downloadDocument(item.s3Key);
        send({
          type: 'bill',
          filename: item.filename,
          extracted: item.extracted,
          match: item.match,
          fileData: buffer.toString('base64'),
        });
      })
    );

    send({ type: 'done', autoImported: job.autoImported });
    res.end();
  } catch (err) { next(err); }
});

export default router;
