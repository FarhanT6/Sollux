import { Router } from 'express';
import { google } from 'googleapis';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
}

// POST /api/gmail/connect — returns OAuth URL
router.post('/connect', async (req, res, next) => {
  try {
    const oauth2Client = getOAuthClient();
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/gmail.readonly'],
      state: req.dbUserId!,
      prompt: 'consent', // force consent so we always get a refresh token
    });
    res.json({ url });
  } catch (err) { next(err); }
});

// GET /api/gmail/callback — OAuth callback (no auth middleware — Google redirects here)
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state: userId } = req.query;
    if (!code || !userId) return res.status(400).json({ error: 'Missing code or state' });

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(String(code));

    // Get the Gmail address that just authorized
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress || '';

    // Upsert by [userId, email] — supports multiple Gmail accounts per user
    await db.gmailToken.upsert({
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
        // Only update refresh token if Google returned a new one
        ...(tokens.refresh_token && { refreshToken: tokens.refresh_token }),
        expiresAt: new Date(tokens.expiry_date!),
      },
    });

    res.redirect(`${process.env.FRONTEND_URL}/settings?gmail=connected&email=${encodeURIComponent(email)}`);
  } catch (err) { next(err); }
});

// GET /api/gmail/status — returns all connected Gmail accounts
router.get('/status', async (req, res, next) => {
  try {
    const tokens = await db.gmailToken.findMany({
      where: { userId: req.dbUserId! },
      select: { id: true, email: true, label: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ connected: tokens.length > 0, accounts: tokens });
  } catch (err) { next(err); }
});

// DELETE /api/gmail/disconnect/:id — remove a connected Gmail account
router.delete('/disconnect/:id', async (req, res, next) => {
  try {
    const token = await db.gmailToken.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
    });
    if (!token) return res.status(404).json({ error: 'Not found' });
    await db.gmailToken.delete({ where: { id: token.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/gmail/sync — queue Gmail parse for ALL connected accounts
router.post('/sync', async (req, res, next) => {
  try {
    const tokens = await db.gmailToken.findMany({ where: { userId: req.dbUserId! } });
    if (!tokens.length) return res.status(400).json({ error: 'No Gmail accounts connected' });

    const { gmailQueue } = await import('../workers/queues');
    const job = await gmailQueue.add('parse', { userId: req.dbUserId! }, { attempts: 2 });
    res.json({ jobId: job.id, accounts: tokens.length, message: 'Gmail sync queued' });
  } catch (err) { next(err); }
});

export default router;
