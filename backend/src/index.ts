import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import propertiesRouter from './routes/properties';
import utilitiesRouter from './routes/utilities';
import statementsRouter from './routes/statements';
import paymentsRouter from './routes/payments';
import insightsRouter from './routes/insights';
import documentsRouter from './routes/documents';
import dashboardRouter from './routes/dashboard';
import gmailRouter from './routes/gmail';
import notificationsRouter from './routes/notifications';
import authRouter from './routes/auth';
import stripeRouter from './routes/stripe';
import { errorHandler } from './middleware/errorHandler';
import { requireAuth, clerkMiddleware } from './middleware/requireAuth';

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Security ────────────────────────────────────────────
app.use(clerkMiddleware());
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    // Allow any localhost port in development, or the configured FRONTEND_URL
    if (!origin || origin.startsWith('http://localhost:') || origin === process.env.FRONTEND_URL) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ─── Body parsing ─────────────────────────────────────────
// Stripe webhook needs raw body — mount before json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// ─── Health check ─────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ─── Public routes ────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/stripe', stripeRouter);

// ─── Protected routes ─────────────────────────────────────
app.use('/api', requireAuth);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/properties', propertiesRouter);
app.use('/api/utilities', utilitiesRouter);
app.use('/api/statements', statementsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/gmail', gmailRouter);
app.use('/api/notifications', notificationsRouter);

// ─── Error handling ───────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🌅 Sollux API running on http://localhost:${PORT}`);
});

export default app;
