import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { encryptOptional, decryptOptional } from '../crypto/encrypt';
import { scrapeQueue } from '../workers/queues';

const router = Router();
router.use(attachDbUser);

// Keeps an INSURANCE-category utility account's linked InsurancePolicy (shown
// under Portfolio → Insurance) in sync: carrier name, policy number (from the
// utility account's "Account number" field — that's the policy number for an
// insurance account), policy type, and active status flow from the utility
// account here; premium/dates/documents stay editable only on the policy
// itself. Called after every utility create/update so adding, renaming, or
// (de)activating an insurance account under Utilities is reflected on the
// Portfolio side without the user re-entering it there.
// A policy's premium frequency and the account's billing cadence describe the
// same fact from two sides, so keep them agreed rather than letting a user set
// "annual" in one place and "monthly" in the other. Only the three cadences
// the policy can express map across; TERM/ONE_TIME/IRREGULAR have no
// equivalent and leave the policy's own value alone.
const CADENCE_TO_PREMIUM_FREQUENCY: Record<string, 'MONTHLY' | 'ANNUAL' | 'SEMI_ANNUAL'> = {
  MONTHLY: 'MONTHLY',
  ANNUAL: 'ANNUAL',
  SEMI_ANNUAL: 'SEMI_ANNUAL',
};

async function syncInsurancePolicyForUtility(
  account: {
    id: string; propertyId: string; providerName: string; category: string; isActive: boolean;
    billingCadence?: string | null; expectedAmount?: any;
  },
  opts: { policyNumber?: string; policyType?: string } = {},
) {
  if (account.category !== 'INSURANCE') {
    // No longer an insurance account — unlink any existing policy but keep
    // it (and its real premium/date data) intact for manual management.
    await db.insurancePolicy.updateMany({
      where: { utilityAccountId: account.id },
      data: { utilityAccountId: null },
    });
    return;
  }

  const frequency = account.billingCadence
    ? CADENCE_TO_PREMIUM_FREQUENCY[account.billingCadence]
    : undefined;

  const existing = await db.insurancePolicy.findUnique({ where: { utilityAccountId: account.id } });
  if (existing) {
    await db.insurancePolicy.update({
      where: { id: existing.id },
      data: {
        carrier: account.providerName,
        isActive: account.isActive,
        ...(opts.policyNumber !== undefined && { policyNumber: opts.policyNumber }),
        ...(opts.policyType !== undefined && { policyType: opts.policyType as any }),
        ...(frequency && { premiumFrequency: frequency }),
        // Only fill a premium the policy doesn't have. A figure entered on the
        // policy itself is the more considered one and must not be overwritten.
        ...(account.expectedAmount != null && Number(existing.premiumAmount) === 0 && {
          premiumAmount: account.expectedAmount,
        }),
      },
    });
  } else {
    await db.insurancePolicy.create({
      data: {
        propertyId: account.propertyId,
        utilityAccountId: account.id,
        carrier: account.providerName,
        policyNumber: opts.policyNumber || null,
        policyType: (opts.policyType as any) || 'PROPERTY',
        premiumAmount: account.expectedAmount ?? 0,
        ...(frequency && { premiumFrequency: frequency }),
        isActive: account.isActive,
      },
    });
  }
}

// Keeps a linked Loan (created via the "Link a loan" flow — see
// PUT /:id/loan below, the "This is also a loan" option on other
// categories, or automatically via the LOAN category below) in sync with
// its utility account's active status, the same way insurance policies
// stay in sync.
async function syncLoanActiveForUtility(account: { id: string; isActive: boolean }) {
  await db.loan.updateMany({
    where: { utilityAccountId: account.id },
    data: { isActive: account.isActive },
  });
}

// Auto-links a LOAN- or CREDIT_CARD-category utility account (auto loan,
// student loan, credit card, etc.) to a Portfolio → Loans entry, the same
// way INSURANCE auto-links to a policy. If an unlinked Loan on this
// property already has a matching lender name (e.g. it was entered
// manually under Portfolio first), link to that one instead of creating a
// duplicate; otherwise create a new one. Switching category away from
// LOAN/CREDIT_CARD unlinks (not deletes) any existing link.
async function syncLoanForUtility(
  account: { id: string; propertyId: string; providerName: string; category: string; isActive: boolean },
  userId: string,
  opts: { loanType?: string } = {},
) {
  if (account.category !== 'LOAN' && account.category !== 'CREDIT_CARD') {
    await db.loan.updateMany({
      where: { utilityAccountId: account.id },
      data: { utilityAccountId: null },
    });
    return;
  }

  const existing = await db.loan.findUnique({ where: { utilityAccountId: account.id } });
  if (existing) {
    await db.loan.update({
      where: { id: existing.id },
      data: {
        lender: account.providerName,
        isActive: account.isActive,
        ...(opts.loanType !== undefined && { loanType: opts.loanType as any }),
      },
    });
    return;
  }

  // Look for an unlinked loan on this property with a matching lender name
  // (e.g. added directly under Portfolio → Loans before this utility
  // account existed) and link to it instead of creating a duplicate.
  const candidate = await db.loan.findFirst({
    where: {
      propertyId: account.propertyId,
      utilityAccountId: null,
      lender: { equals: account.providerName, mode: 'insensitive' },
    },
  });
  if (candidate) {
    await db.loan.update({
      where: { id: candidate.id },
      data: { utilityAccountId: account.id, isActive: account.isActive },
    });
    return;
  }

  await db.loan.create({
    data: {
      userId,
      propertyId: account.propertyId,
      utilityAccountId: account.id,
      lender: account.providerName,
      loanType: (opts.loanType as any) || (account.category === 'CREDIT_CARD' ? 'CREDIT_LINE' : 'OTHER'),
      isActive: account.isActive,
      isPersonal: false,
    },
  });
}

/**
 * A meter can only serve a unit of the property it belongs to. Without this a
 * unit id from another property would be accepted and the meter would show up
 * labelled with a unit that isn't there.
 */
async function assertUnitBelongsToProperty(unitId: string | null | undefined, propertyId: string) {
  if (!unitId) return;
  const unit = await db.unit.findFirst({ where: { id: unitId, propertyId }, select: { id: true } });
  if (!unit) {
    const err: any = new Error('That unit belongs to a different property.');
    err.status = 400;
    throw err;
  }
}

const UtilitySchema = z.object({
  propertyId: z.string(),
  providerName: z.string().min(1),
  providerSlug: z.string().min(1),
  accountNumber: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  loginUrl: z.union([z.string().url(), z.literal('')]).optional().transform(v => v === '' ? null : v),
  category: z.enum(['ELECTRIC', 'GAS', 'WATER', 'SEWER', 'TRASH', 'SOLAR',
    'INTERNET', 'PHONE', 'INSURANCE', 'HOA', 'TAXES', 'LOAN', 'CREDIT_CARD', 'OTHER']),
  notes: z.string().optional(),
  isActive: z.boolean().optional(),
  // Which unit this meter serves. Empty string clears the link — a plain
  // `undefined` can't, and a meter does get reassigned.
  unitId: z.string().nullable().optional().transform(v => v === '' ? null : v),
  serviceLabel: z.string().optional().transform(v => v === '' ? null : v),
  // How often this account bills, and what one bill looks like. Needed for
  // anything that costs a month: an annual premium is not a monthly expense.
  billingCadence: z.enum(['MONTHLY','QUARTERLY','SEMI_ANNUAL','ANNUAL','TERM','ONE_TIME','IRREGULAR']).optional(),
  // Payment rules you know and the statements do not state. These override
  // what billing history infers — see paymentPriority.ts.
  graceDays: z.number().int().min(0).max(365).nullable().optional(),
  lateFeeFixed: z.number().nonnegative().nullable().optional(),
  lateFeePercent: z.number().min(0).max(100).nullable().optional(),
  shutoffAfterDays: z.number().int().min(0).max(730).nullable().optional(),
  paymentRuleNotes: z.string().nullable().optional(),
  termMonths: z.number().int().positive().max(600).optional(),
  expectedAmount: z.number().nonnegative().optional(),
  // Only relevant when category is INSURANCE — passed through to the linked
  // InsurancePolicy's policyType, not stored on the utility account itself.
  insuranceType: z.enum(['PROPERTY', 'LIABILITY', 'FLOOD', 'UMBRELLA', 'OTHER']).optional(),
  // Only relevant when category is LOAN — passed through to the linked
  // Loan's loanType, not stored on the utility account itself.
  loanType: z.enum(['MORTGAGE', 'HELOC', 'AUTO', 'PERSONAL', 'STUDENT', 'INSTALLMENT_PLAN',
    'CREDIT_LINE', 'SELLER_FINANCING', 'DSCR', 'COMMERCIAL', 'HARD_MONEY', 'OTHER']).optional(),
});

// GET /api/utilities?propertyId=xxx
router.get('/', async (req, res, next) => {
  try {
    const { propertyId } = req.query;

    // Verify property belongs to user
    const where: any = {};
    if (propertyId) {
      const property = await db.property.findFirst({
        where: { id: String(propertyId), userId: req.dbUserId! },
      });
      if (!property) return res.status(404).json({ error: 'Property not found' });
      where.propertyId = String(propertyId);
    } else {
      // All utilities across all user properties
      const userProperties = await db.property.findMany({
        where: { userId: req.dbUserId! },
        select: { id: true },
      });
      where.propertyId = { in: userProperties.map(p => p.id) };
    }

    const accounts = await db.utilityAccount.findMany({
      where,
      include: {
        statements: { orderBy: { statementDate: 'desc' }, take: 1 },
        payments: { orderBy: { paymentDate: 'desc' }, take: 1 },
        unit: { select: { id: true, unitLabel: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Never return encrypted credential fields
    const sanitized = accounts.map(({ accountNumberEnc, usernameEnc, passwordEnc, ...rest }) => ({
      ...rest,
      hasCredentials: !!usernameEnc,
    }));
    res.json(sanitized);
  } catch (err) {
    next(err);
  }
});

// POST /api/utilities — add new account (encrypts credentials)
router.post('/', async (req, res, next) => {
  try {
    const { propertyId, username, password, accountNumber, insuranceType, loanType, ...rest } = UtilitySchema.parse(req.body);

    // Verify property belongs to user
    const property = await db.property.findFirst({
      where: { id: propertyId, userId: req.dbUserId! },
    });
    if (!property) return res.status(403).json({ error: 'Property not found' });

    await assertUnitBelongsToProperty(rest.unitId, propertyId);

    // A property can legitimately hold two accounts with the same provider and
    // category — two water meters, a second trash bin — so the guard is the
    // account number, not the provider. Same provider, same category, same
    // number is the same account, and creating it again is a double submit
    // (or a client retrying a request that failed after the write landed).
    if (accountNumber) {
      const duplicate = await db.utilityAccount.findFirst({
        where: {
          propertyId,
          providerSlug: rest.providerSlug,
          category: rest.category,
          accountNumber: `****${accountNumber.slice(-4)}`,
        },
        select: { id: true, providerName: true },
      });
      if (duplicate) {
        return res.status(409).json({
          error: `${duplicate.providerName} with that account number is already connected to this property.`,
          existingId: duplicate.id,
        });
      }
    }

    const account = await db.utilityAccount.create({
      data: {
        propertyId,
        ...rest,
        // Store only last 4 of account number for display
        accountNumber: accountNumber ? `****${accountNumber.slice(-4)}` : null,
        accountNumberEnc: encryptOptional(accountNumber),
        usernameEnc: encryptOptional(username),
        passwordEnc: encryptOptional(password),
      },
    });

    await syncInsurancePolicyForUtility(account, { policyNumber: accountNumber, policyType: insuranceType });
    await syncLoanForUtility(account, req.dbUserId!, { loanType });

    // Queue an initial scrape, but never let that failure undo the request.
    // The account is already created; if Redis is unreachable or over quota,
    // enqueueing throws and the client sees "Internal server error" for an
    // account that exists — so retrying creates a duplicate. A missed initial
    // sync is recoverable from the Sync button; a phantom failure is not.
    try {
      await scrapeQueue.add('scrape', { utilityAccountId: account.id }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 120000 },
      });
    } catch (err) {
      console.error('[Utilities] Account created but initial scrape could not be queued:', err instanceof Error ? err.message : err);
    }

    res.status(201).json(account);
  } catch (err) {
    next(err);
  }
});

// GET /api/utilities/:id — single utility account detail
router.get('/:id', async (req, res, next) => {
  try {
    const account = await db.utilityAccount.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
      include: {
        property: { select: { id: true, address: true, nickname: true, city: true, state: true } },
        unit: { select: { id: true, unitLabel: true } },
        // Was capped at 84 (seven years of monthly bills), which silently
        // truncated a longer history — and the page's totals are computed from
        // this array, so the stat cards were wrong too, not just the list.
        // A decade of monthly bills is ~120 rows; this is a sanity guard, not
        // a display limit.
        statements: { orderBy: { statementDate: 'desc' }, take: 600 },
        payments: {
          orderBy: { paymentDate: 'desc' }, take: 200,
          include: {
            statement: { select: { id: true, statementDate: true, amountDue: true } },
            bankAccount: { select: { id: true, name: true, bank: true, last4: true } },
          },
        },
        loan: true,
      },
    });
    if (!account) return res.status(404).json({ error: 'Not found' });
    const { accountNumberEnc, usernameEnc, passwordEnc, ...rest } = account;
    res.json({ ...rest, hasCredentials: !!usernameEnc });
  } catch (err) { next(err); }
});

// GET /api/utilities/:id/account-number — decrypt and reveal the full
// account number on explicit user request (not included in normal list/
// detail responses, which only carry the masked "****1234" display value).
router.get('/:id/account-number', async (req, res, next) => {
  try {
    const account = await db.utilityAccount.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
      select: { accountNumberEnc: true },
    });
    if (!account) return res.status(404).json({ error: 'Not found' });
    res.json({ accountNumber: decryptOptional(account.accountNumberEnc) });
  } catch (err) { next(err); }
});

// GET /api/utilities/:id/username — decrypted login username, fetched by the
// Edit form on open so it's always visible there (lower-sensitivity than the
// password, so no explicit reveal click needed).
router.get('/:id/username', async (req, res, next) => {
  try {
    const account = await db.utilityAccount.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
      select: { usernameEnc: true },
    });
    if (!account) return res.status(404).json({ error: 'Not found' });
    res.json({ username: decryptOptional(account.usernameEnc) });
  } catch (err) { next(err); }
});

// GET /api/utilities/:id/password — decrypt and reveal the login password on
// explicit user request only (never included in normal responses or
// auto-fetched, unlike the username above).
router.get('/:id/password', async (req, res, next) => {
  try {
    const account = await db.utilityAccount.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
      select: { passwordEnc: true },
    });
    if (!account) return res.status(404).json({ error: 'Not found' });
    res.json({ password: decryptOptional(account.passwordEnc) });
  } catch (err) { next(err); }
});

// POST /api/utilities/:id/sync — trigger manual scrape
router.post('/:id/sync', async (req, res, next) => {
  try {
    const account = await db.utilityAccount.findFirst({
      where: {
        id: req.params.id,
        property: { userId: req.dbUserId! },
      },
    });
    if (!account) return res.status(404).json({ error: 'Utility account not found' });

    if (!account.usernameEnc) {
      // Mark as failed immediately with a clear message rather than queuing a job that will fail
      await db.utilityAccount.update({
        where: { id: account.id },
        data: {
          lastSyncStatus: 'FAILED',
          lastSyncError: 'No credentials — open Edit to add your username and password for this provider.',
        },
      });
      return res.json({ message: 'No credentials set up' });
    }

    const job = await scrapeQueue.add('scrape', { utilityAccountId: account.id }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 120000 },
    });

    res.json({ jobId: job.id, message: 'Sync queued' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/utilities/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { username, password, accountNumber, insuranceType, loanType, ...rest } = UtilitySchema.partial().parse(req.body);

    const existing = await db.utilityAccount.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
    });
    if (!existing) return res.status(404).json({ error: 'Utility account not found' });

    await assertUnitBelongsToProperty(rest.unitId, existing.propertyId);

    const updated = await db.utilityAccount.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        ...(accountNumber !== undefined && {
          accountNumber: `****${accountNumber.slice(-4)}`,
          accountNumberEnc: encryptOptional(accountNumber),
        }),
        ...(username !== undefined && { usernameEnc: encryptOptional(username) }),
        ...(password !== undefined && { passwordEnc: encryptOptional(password) }),
        // Deactivating pauses the auto-scraper too (no point syncing an account
        // you've marked as no longer in use); reactivating resumes it.
        ...(rest.isActive === false && { syncEnabled: false }),
        ...(rest.isActive === true && { syncEnabled: true }),
      },
    });

    await syncInsurancePolicyForUtility(updated, { policyNumber: accountNumber, policyType: insuranceType });
    await syncLoanForUtility(updated, req.dbUserId!, { loanType });
    await syncLoanActiveForUtility(updated);

    const { accountNumberEnc, usernameEnc, passwordEnc, ...sanitized } = updated;
    res.json(sanitized);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/utilities/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.utilityAccount.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
    });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    await db.utilityAccount.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── PAYMENT PLAN ROUTES ─────────────────────────────────

const PaymentPlanSchema = z.object({
  totalAmount:    z.number().positive(),
  monthlyAmount:  z.number().positive(),
  startDate:      z.string(),        // ISO date string
  description:    z.string().optional(),
});

/** Verify the utility account belongs to the requesting user. */
async function requireOwnedAccount(accountId: string, userId: string) {
  return db.utilityAccount.findFirst({
    where: { id: accountId, property: { userId } },
  });
}

// GET /api/utilities/:id/payment-plan
router.get('/:id/payment-plan', async (req, res, next) => {
  try {
    const account = await requireOwnedAccount(req.params.id, req.dbUserId!);
    if (!account) return res.status(404).json({ error: 'Not found' });

    // Most accounts have no payment plan, and that is the normal case rather
    // than an error. Answering 404 made every utility page log a failed request
    // to the console, which buries the failures that do matter.
    const plan = await db.paymentPlan.findUnique({ where: { utilityAccountId: req.params.id } });
    res.json(plan ?? null);
  } catch (err) { next(err); }
});

// POST /api/utilities/:id/payment-plan  — create or replace
router.post('/:id/payment-plan', async (req, res, next) => {
  try {
    const account = await requireOwnedAccount(req.params.id, req.dbUserId!);
    if (!account) return res.status(404).json({ error: 'Not found' });

    const body = PaymentPlanSchema.parse(req.body);
    const plan = await db.paymentPlan.upsert({
      where: { utilityAccountId: req.params.id },
      create: {
        utilityAccountId: req.params.id,
        totalAmount:      body.totalAmount,
        remainingBalance: body.totalAmount,  // starts at full amount
        monthlyAmount:    body.monthlyAmount,
        startDate:        new Date(body.startDate),
        description:      body.description,
        status:           'ACTIVE',
      },
      update: {
        totalAmount:      body.totalAmount,
        remainingBalance: body.totalAmount,  // reset on re-create
        monthlyAmount:    body.monthlyAmount,
        startDate:        new Date(body.startDate),
        description:      body.description,
        status:           'ACTIVE',
      },
    });
    res.json(plan);
  } catch (err) { next(err); }
});

// PATCH /api/utilities/:id/payment-plan  — update fields (including apply a payment)
router.patch('/:id/payment-plan', async (req, res, next) => {
  try {
    const account = await requireOwnedAccount(req.params.id, req.dbUserId!);
    if (!account) return res.status(404).json({ error: 'Not found' });

    const plan = await db.paymentPlan.findUnique({ where: { utilityAccountId: req.params.id } });
    if (!plan) return res.status(404).json({ error: 'No payment plan' });

    const { applyPayment, remainingBalance, status, monthlyAmount, description } = req.body;

    let newRemaining = Number(plan.remainingBalance);

    if (typeof applyPayment === 'number' && applyPayment > 0) {
      newRemaining = Math.max(0, newRemaining - applyPayment);
    } else if (typeof remainingBalance === 'number') {
      newRemaining = Math.max(0, remainingBalance);
    }

    const newStatus = newRemaining <= 0 ? 'COMPLETED'
      : (status === 'CANCELLED' ? 'CANCELLED' : plan.status);

    const updated = await db.paymentPlan.update({
      where: { utilityAccountId: req.params.id },
      data: {
        remainingBalance: newRemaining,
        status:           newStatus,
        ...(typeof monthlyAmount === 'number' ? { monthlyAmount } : {}),
        ...(description !== undefined ? { description } : {}),
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/utilities/:id/payment-plan
router.delete('/:id/payment-plan', async (req, res, next) => {
  try {
    const account = await requireOwnedAccount(req.params.id, req.dbUserId!);
    if (!account) return res.status(404).json({ error: 'Not found' });

    await db.paymentPlan.deleteMany({ where: { utilityAccountId: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── Loan linked to this utility account ──────────────────────────────────────

// PUT /api/utilities/:id/loan  — create or update the linked loan
router.put('/:id/loan', async (req, res, next) => {
  try {
    const account = await requireOwnedAccount(req.params.id, req.dbUserId!);
    if (!account) return res.status(404).json({ error: 'Not found' });

    const {
      loanType, lender, accountLast4, originalAmount, interestRate,
      originationDate, maturityDate, monthlyPayment, currentBalance, notes,
    } = req.body;

    const existing = await db.loan.findUnique({ where: { utilityAccountId: req.params.id } });

    if (existing) {
      const updated = await db.loan.update({
        where: { id: existing.id },
        data: {
          loanType:       loanType       ?? existing.loanType,
          lender:         lender         ?? existing.lender,
          accountLast4:   accountLast4   ?? existing.accountLast4,
          originalAmount: originalAmount != null ? originalAmount : existing.originalAmount,
          interestRate:   interestRate   != null ? interestRate   : existing.interestRate,
          originationDate: originationDate ? new Date(originationDate) : existing.originationDate,
          maturityDate:   maturityDate   ? new Date(maturityDate)   : existing.maturityDate,
          monthlyPayment: monthlyPayment != null ? monthlyPayment : existing.monthlyPayment,
          currentBalance: currentBalance != null ? currentBalance : existing.currentBalance,
          notes:          notes          ?? existing.notes,
        },
      });
      return res.json(updated);
    }

    const created = await db.loan.create({
      data: {
        userId:          req.dbUserId!,
        propertyId:      account.propertyId,
        utilityAccountId: req.params.id,
        loanType:        loanType || 'OTHER',
        lender:          lender   || account.providerName,
        accountLast4,
        originalAmount,
        interestRate,
        originationDate: originationDate ? new Date(originationDate) : null,
        maturityDate:    maturityDate    ? new Date(maturityDate)    : null,
        monthlyPayment,
        currentBalance,
        notes,
        isPersonal: false,
      },
    });
    return res.json(created);
  } catch (err) { next(err); }
});

// DELETE /api/utilities/:id/loan
router.delete('/:id/loan', async (req, res, next) => {
  try {
    const account = await requireOwnedAccount(req.params.id, req.dbUserId!);
    if (!account) return res.status(404).json({ error: 'Not found' });

    await db.loan.updateMany({
      where: { utilityAccountId: req.params.id },
      data: { utilityAccountId: null },
    });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
