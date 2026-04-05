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
      prompt: 'consent',
    });
    res.json({ url });
  } catch (err) { next(err); }
});

// GET /api/gmail/callback — OAuth callback
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state: userId } = req.query;
    if (!code || !userId) return res.status(400).json({ error: 'Missing code or state' });

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(String(code));

    // Get Gmail email address
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress || '';

    await db.gmailToken.upsert({
      where: { userId: String(userId) },
      create: {
        userId: String(userId),
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token!,
        expiresAt: new Date(tokens.expiry_date!),
        email,
      },
      update: {
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token!,
        expiresAt: new Date(tokens.expiry_date!),
        email,
      },
    });

    res.redirect(`${process.env.FRONTEND_URL}/settings?gmail=connected`);
  } catch (err) { next(err); }
});

// GET /api/gmail/status
router.get('/status', async (req, res, next) => {
  try {
    const token = await db.gmailToken.findUnique({ where: { userId: req.dbUserId! } });
    res.json({ connected: !!token, email: token?.email });
  } catch (err) { next(err); }
});

// POST /api/gmail/sync — queue a Gmail parse job for current user
router.post('/sync', async (req, res, next) => {
  try {
    const token = await db.gmailToken.findUnique({ where: { userId: req.dbUserId! } });
    if (!token) return res.status(400).json({ error: 'Gmail not connected' });

    const { gmailQueue } = await import('../workers/queues');
    const job = await gmailQueue.add('parse', { userId: req.dbUserId! }, { attempts: 2 });
    res.json({ jobId: job.id, message: 'Gmail sync queued' });
  } catch (err) { next(err); }
});

export default router;
