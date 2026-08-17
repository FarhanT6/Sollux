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
import driveRouter from './routes/drive';
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
import indexRatesRouter from './routes/indexRates';
import reconciliationRouter from './routes/reconciliation';
import scanDocumentsRouter from './routes/scanDocuments';
import reportsRouter from './routes/reports';
import transactionsRouter from './routes/transactions';
import outgoingTransactionsRouter from './routes/outgoingTransactions';
import insuranceRouter from './routes/insurance';
import taxesRouter from './routes/taxes';
import improvementsRouter from './routes/improvements';
import legalRouter from './routes/legal';
import pnlRouter from './routes/pnl';
import bankAccountsRouter from './routes/bankAccounts';
import otherIncomeRouter from './routes/otherIncome';
import budgetRouter from './routes/budget';
import aiRouter from './routes/ai';
import plaidRouter from './routes/plaid';
import { errorHandler } from './middleware/errorHandler';
import { requireAuth, clerkMiddleware } from './middleware/requireAuth';

// Run the Drive-import and Gmail workers in the API process. Ideally these
// live in a separate Render service, but a Background Worker costs extra —
// and these two workers only need Redis (no Playwright, no browser profiles),
// so co-hosting is safe. Importing the file starts the BullMQ Worker instance
// that consumes the queue and processes jobs. Without this, POST /drive/import
// enqueues a job that no one ever consumes.
import './workers/driveImportWorker';
import './workers/gmailWorker';
console.log('🔧 Inline workers started: driveImport, gmail');

const app = express();
const PORT = process.env.PORT || 3001;

// Render sits in front of this app behind its own reverse proxy, so every
// request carries an X-Forwarded-For header. Without this, express-rate-limit
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request under the
// limiter (all of /api/), since it refuses to trust that header by default.
app.set('trust proxy', 1);

// ─── Security ────────────────────────────────────────────
// clerkMiddleware() intercepts any request without a Clerk dev-browser
// handshake and 302s it to "/" when a pk_test_ key is in production use.
// Google's OAuth redirect back to /api/{gmail,drive}/callback obviously
// can't carry that handshake, so those routes must skip Clerk entirely.
const clerkMw = clerkMiddleware();
app.use((req, res, next) => {
  if (req.path === '/api/gmail/callback' || req.path === '/api/drive/callback') {
    return next();
  }
  return clerkMw(req, res, next);
});
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (
      !origin ||
      origin.startsWith('http://localhost:') ||
      origin === process.env.FRONTEND_URL ||
      /^https:\/\/sollux[a-z0-9-]*\.vercel\.app$/.test(origin)
    ) {
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
// Lease/tenant document uploads (lease agreements, applications, scans) can be
// large multi-page PDFs — allow well above the default before the global cap.
app.use('/api/leases', express.json({ limit: '50mb' }));
app.use(express.json({ limit: '10mb' }));

// ─── Health check ─────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ─── Public routes ────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/stripe', stripeRouter);

// ─── Protected routes ─────────────────────────────────────
// requireAuth() redirects unauthed requests to "/" — Google's redirect back
// to our OAuth callbacks obviously isn't authed, so those two paths need to
// bypass this the same way they bypass clerkMiddleware above.
app.use('/api', (req, res, next) => {
  if (req.path === '/gmail/callback' || req.path === '/drive/callback') {
    return next();
  }
  return requireAuth(req, res, next);
});
app.use('/api/dashboard', dashboardRouter);
app.use('/api/properties', propertiesRouter);
app.use('/api/utilities', utilitiesRouter);
app.use('/api/statements', statementsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/gmail', gmailRouter);
app.use('/api/drive', driveRouter);
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
app.use('/api/index-rates', indexRatesRouter);
app.use('/api/reconciliation', reconciliationRouter);
app.use('/api/scanned-documents', scanDocumentsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/expense-transactions', outgoingTransactionsRouter);
app.use('/api/insurance', insuranceRouter);
app.use('/api/taxes', taxesRouter);
app.use('/api/improvements', improvementsRouter);
app.use('/api/legal', legalRouter);
app.use('/api/pnl', pnlRouter);
app.use('/api/bank-accounts', bankAccountsRouter);
app.use('/api/other-income', otherIncomeRouter);
app.use('/api/budget', budgetRouter);
app.use('/api/ai', aiRouter);
app.use('/api/plaid', plaidRouter);

// ─── Error handling ───────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🌅 Sollux API running on http://localhost:${PORT}`);
});

export default app;
