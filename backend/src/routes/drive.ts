import { Router } from 'express';
import { google } from 'googleapis';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { getSignedDocumentUrl } from '../services/s3Service';

const router = Router();
router.use(attachDbUser);

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.DRIVE_REDIRECT_URI
  );
}

// POST /api/drive/connect — returns OAuth URL
router.post('/connect', async (req, res, next) => {
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
router.get('/status', async (req, res, next) => {
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
router.delete('/disconnect/:id', async (req, res, next) => {
  try {
    const token = await db.driveToken.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
    });
    if (!token) return res.status(404).json({ error: 'Not found' });
    await db.driveToken.delete({ where: { id: token.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

async function getDriveClientForToken(tokenId: string, userId: string) {
  const token = await db.driveToken.findFirst({ where: { id: tokenId, userId } });
  if (!token) throw new Error('Drive account not found');

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiresAt.getTime(),
  });

  // Persist refreshed tokens so future jobs don't need to re-auth.
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

// GET /api/drive/browse?tokenId=&folderId= — list folders + PDFs one level deep
// (folderId omitted browses the account's root)
router.get('/browse', async (req, res, next) => {
  try {
    const { tokenId, folderId } = req.query as { tokenId?: string; folderId?: string };
    if (!tokenId) return res.status(400).json({ error: 'tokenId required' });

    const drive = await getDriveClientForToken(tokenId, req.dbUserId!);
    const parent = folderId || 'root';

    const result = await drive.files.list({
      q: `'${parent}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/pdf')`,
      fields: 'files(id, name, mimeType)',
      orderBy: 'folder,name',
      pageSize: 200,
    });

    res.json({ files: result.data.files || [] });
  } catch (err) { next(err); }
});

// POST /api/drive/import  { tokenId, folderId, folderName? } — queues background import
router.post('/import', async (req, res, next) => {
  try {
    const { tokenId, folderId, folderName } = req.body as { tokenId: string; folderId: string; folderName?: string };
    if (!tokenId || !folderId) return res.status(400).json({ error: 'tokenId and folderId required' });

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
      { jobId: job.id, tokenId, folderId, userId: req.dbUserId! },
      { attempts: 1 }
    );

    res.json({ jobId: job.id });
  } catch (err) { next(err); }
});

// GET /api/drive/jobs/:id — poll progress; needsReview items get fresh signed S3 URLs
router.get('/jobs/:id', async (req, res, next) => {
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

export default router;
