import { Router } from 'express';
import { google } from 'googleapis';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { getSignedDocumentUrl, downloadDocument } from '../services/s3Service';

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

// POST /api/drive/import  { tokenId, folderId?, fileIds?, folderName? } — queues background import
// Either folderId (import everything in it recursively), fileIds (import just
// this specific list of files), or both (import that folder AND the loose files).
router.post('/import', attachDbUser, async (req, res, next) => {
  try {
    const { tokenId, folderId, fileIds, folderName } = req.body as {
      tokenId: string;
      folderId?: string;
      fileIds?: string[];
      folderName?: string;
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
      { jobId: job.id, tokenId, folderId, fileIds, userId: req.dbUserId! },
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
