import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

// ── Notifications ────────────────────────────────────────
export const notificationsRouter = Router();
notificationsRouter.use(attachDbUser);

notificationsRouter.get('/preferences', async (req, res, next) => {
  try {
    const prefs = await db.notificationPreference.findMany({ where: { userId: req.dbUserId! } });
    res.json(prefs);
  } catch (err) { next(err); }
});

notificationsRouter.patch('/preferences', async (req, res, next) => {
  try {
    const { channel, eventType, isEnabled, thresholdDays } = req.body;
    const pref = await db.notificationPreference.upsert({
      where: { userId_channel_eventType: { userId: req.dbUserId!, channel, eventType } },
      create: { userId: req.dbUserId!, channel, eventType, isEnabled, thresholdDays: thresholdDays || 5 },
      update: { isEnabled, thresholdDays },
    });
    res.json(pref);
  } catch (err) { next(err); }
});

// ── Auth ─────────────────────────────────────────────────
export const authRouter = Router();

authRouter.get('/me', async (req, res) => {
  // Clerk handles auth — this just confirms the backend is alive
  res.json({ status: 'ok', message: 'Auth is handled by Clerk' });
});

// ── Stripe ───────────────────────────────────────────────
export const stripeRouter = Router();

stripeRouter.post('/webhook', async (req, res) => {
  // TODO: Handle Stripe webhooks (subscription.created, subscription.deleted, etc.)
  // Verify webhook signature using STRIPE_WEBHOOK_SECRET
  res.json({ received: true });
});

stripeRouter.post('/create-checkout', attachDbUser, async (req, res, next) => {
  try {
    // TODO: Create Stripe checkout session for plan upgrade
    // import Stripe from 'stripe';
    // const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    res.json({ url: 'https://checkout.stripe.com/placeholder' });
  } catch (err) { next(err); }
});

// ── Documents ────────────────────────────────────────────
export const documentsRouter = Router();
documentsRouter.use(attachDbUser);

documentsRouter.get('/', async (req, res, next) => {
  try {
    const { propertyId, utilityAccountId } = req.query;
    const where: any = { pdfS3Key: { not: null } };

    if (utilityAccountId) {
      where.utilityAccountId = String(utilityAccountId);
    } else if (propertyId) {
      where.utilityAccount = { propertyId: String(propertyId) };
    } else {
      const userProperties = await db.property.findMany({
        where: { userId: req.dbUserId! }, select: { id: true },
      });
      where.utilityAccount = { propertyId: { in: userProperties.map(p => p.id) } };
    }

    const statements = await db.statement.findMany({
      where,
      orderBy: { statementDate: 'desc' },
      take: 200,
      include: {
        utilityAccount: {
          select: {
            providerName: true, category: true,
            property: { select: { address: true, nickname: true } },
          },
        },
      },
    });
    res.json(statements);
  } catch (err) { next(err); }
});
