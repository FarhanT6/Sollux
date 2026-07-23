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
import importRouter from './routes/import';
import unitsRouter from './routes/units';
import tenantsRouter from './routes/tenants';
import leasesRouter from './routes/leases';
import rentPaymentsRouter from './routes/rentPayments';
import noticesRouter from './routes/notices';
import expensesRouter from './routes/expenses';
import loansRouter from './routes/loans';
import insuranceRouter from './routes/insurance';
import taxesRouter from './routes/taxes';
import improvementsRouter from './routes/improvements';
import legalRouter from './routes/legal';
import pnlRouter from './routes/pnl';
import { errorHandler } from './middleware/errorHandler';
import { requireAuth, clerkMiddleware } from './middleware/requireAuth';

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Security ────────────────────────────────────────────
app.use(clerkMiddleware());
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('http://localhost:') || origin === process.env.FRONTEND_URL) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ─── Body parsing ─────────────────────────────────────────
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use('/api/import', express.json({ limit: '100mb' }));
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
app.use('/api/import', importRouter);
// Property management
app.use('/api/units', unitsRouter);
app.use('/api/tenants', tenantsRouter);
app.use('/api/leases', leasesRouter);
app.use('/api/rent-payments', rentPaymentsRouter);
app.use('/api/notices', noticesRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/loans', loansRouter);
app.use('/api/insurance', insuranceRouter);
app.use('/api/taxes', taxesRouter);
app.use('/api/improvements', improvementsRouter);
app.use('/api/legal', legalRouter);
app.use('/api/pnl', pnlRouter);

// ─── Error handling ───────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🌅 Sollux API running on http://localhost:${PORT}`);
});

export default app;
