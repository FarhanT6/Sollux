import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { lookupPropertyRecord, lookupValueEstimate } from '../services/rentcastService';

const router = Router();
router.use(attachDbUser);

const PropertySchema = z.object({
  nickname: z.string().optional().nullable(),
  address: z.string().min(1),
  addressLine2: z.string().optional().nullable(),
  city: z.string().min(1),
  county: z.string().optional().nullable(),
  state: z.string().min(2).max(2),
  zip: z.string(), // many legacy/vacant-land properties have no zip on file; '' is valid
  country: z.string().optional(),
  region: z.string().optional().nullable(),
  type: z.enum(['PRIMARY', 'RENTAL', 'INVESTMENT', 'COMMERCIAL', 'MIXED_USE', 'RESIDENTIAL_SINGLE', 'RESIDENTIAL_MULTI', 'LAND', 'GOLF_COURSE', 'OTHER']),
  status: z.enum(['ACTIVE', 'SOLD', 'UNDER_CONTRACT', 'INACTIVE']).optional(),
  acquisitionDate: z.string().transform(s => new Date(s)).optional().nullable(),
  acquisitionPrice: z.number().optional().nullable(),
  ownerEntity: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  estimatedValue: z.number().optional().nullable(),
  landValue: z.number().optional().nullable(),
  valuationDate: z.string().transform(s => new Date(s)).optional().nullable(),
  valuationNotes: z.string().optional().nullable(),
  lotSqft: z.number().optional().nullable(),
  parcelGroupName: z.string().optional().nullable(),
});

// GET /api/properties — list all for user
/**
 * GET /api/properties/spend-data
 *
 * Just enough to compute monthly spend across the portfolio: every account's
 * billing history for the window, and nothing else.
 *
 * The properties list carries one statement per account, which is right for
 * the cards — they show the latest bill — but computing an average from it
 * produced an average of one bill, so every property reported its latest month
 * and its average as the same number. Sending the full history on that
 * endpoint instead would mean shipping rawDataJson for hundreds of statements
 * to render a handful of figures, so the spend calculation gets its own slim
 * feed.
 */
router.get('/spend-data', async (req, res, next) => {
  try {
    const months = req.query.months ? Number(req.query.months) : 13;
    const since = new Date();
    since.setMonth(since.getMonth() - months);

    const properties = await db.property.findMany({
      where: { userId: req.dbUserId! },
      select: {
        id: true, address: true, nickname: true,
        utilityAccounts: {
          select: {
            id: true, providerName: true, serviceLabel: true, category: true, isActive: true,
            billingCadence: true, termMonths: true, expectedAmount: true, escrowLoanId: true,
            statements: {
              where: { statementDate: { gte: since } },
              orderBy: { statementDate: 'desc' },
              // Only the fields the calculation reads. rawDataJson is the bulk
              // of a statement row and none of it is needed here.
              select: {
                id: true, statementDate: true, billingPeriodEnd: true,
                amountDue: true, penaltiesFees: true, paymentPlanAmount: true,
                isDownPayment: true,
              },
            },
          },
        },
      },
      orderBy: { address: 'asc' },
    });

    res.json(properties);
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const properties = await db.property.findMany({
      where: { userId: req.dbUserId! },
      include: {
        utilityAccounts: {
          select: {
            id: true,
            providerName: true,
            category: true,
            isActive: true,
            escrowLoanId: true,
            escrowLoan: { select: { lender: true } },
            lastSyncStatus: true,
            lastSyncedAt: true,
            // The newest few bills, not one: whether the newest is paid
            // depends on whether the one before it is, and the card's
            // "past due" is the carried balance only while that prior bill
            // is still open.
            statements: {
              orderBy: { statementDate: 'desc' },
              take: 4,
              select: { id: true, amountDue: true, dueDate: true, amountPaid: true, rawDataJson: true, statementDate: true, penaltyDate: true, pastDueCarried: true, penaltiesFees: true, paymentPlanAmount: true, balance: true, paidOverride: true, trueUpDeferred: true, trueUpBalance: true, trueUpDate: true, isScheduled: true },
            },
            payments: {
              orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
              take: 12,
              // The bill a payment was logged toward may be older than the
              // few statements sent here; its date travels with the payment so
              // the card can still tell it reduced the newest bill's arrears.
              select: { id: true, paymentDate: true, amount: true, statementId: true, status: true, notes: true, createdAt: true, statement: { select: { id: true, statementDate: true } } },
            },
          },
        },
        _count: { select: { insights: { where: { isRead: false } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(properties);
  } catch (err) {
    next(err);
  }
});

// GET /api/properties/lookup?address=&city=&state=&zip= — RentCast property
// details + automated valuation for an address. Returns suggested values for
// the UI to prefill; nothing is saved until the user confirms via PATCH.
router.get('/lookup', async (req, res, next) => {
  try {
    const { address, city, state, zip } = req.query as Record<string, string>;
    if (!address || !city || !state) {
      return res.status(400).json({ error: 'address, city, and state are required' });
    }

    const q = { address, city, state, zip: zip || undefined };
    const [recordResult, valuationResult] = await Promise.allSettled([
      lookupPropertyRecord(q),
      lookupValueEstimate(q),
    ]);

    const record = recordResult.status === 'fulfilled' ? recordResult.value : null;
    const valuation = valuationResult.status === 'fulfilled' ? valuationResult.value : null;

    if (!record && !valuation) {
      const reason = recordResult.status === 'rejected'
        ? (recordResult.reason?.response?.data?.message || recordResult.reason?.message || 'Unknown error')
        : 'No RentCast data found for this address';
      return res.status(404).json({ error: reason });
    }

    res.json({ record, valuation });
  } catch (err) { next(err); }
});

// GET /api/properties/:id
router.get('/:id', async (req, res, next) => {
  try {
    const property = await db.property.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
      include: {
        utilityAccounts: {
          include: {
            statements: { orderBy: { statementDate: 'desc' }, take: 6 },
            // createdAt breaks a same-day tie so "the latest payment" is the
            // one logged last, not whichever row the database returns first.
            payments: { orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }], take: 12, include: { statement: { select: { id: true, statementDate: true } } } },
          },
        },
        insights: {
          where: { isDismissed: false },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!property) return res.status(404).json({ error: 'Property not found' });

    // Never return encrypted credential fields
    const utilityAccounts = property.utilityAccounts.map(({ accountNumberEnc, usernameEnc, passwordEnc, ...rest }) => ({
      ...rest,
      hasCredentials: !!usernameEnc,
    }));
    res.json({ ...property, utilityAccounts });
  } catch (err) {
    next(err);
  }
});

// POST /api/properties
router.post('/', async (req, res, next) => {
  try {
    const data = PropertySchema.parse(req.body);
    const property = await db.property.create({
      data: { ...data, userId: req.dbUserId! },
    });
    res.status(201).json(property);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/properties/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const data = PropertySchema.partial().parse(req.body);
    const existing = await db.property.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
    });
    if (!existing) return res.status(404).json({ error: 'Property not found' });

    const updated = await db.property.update({
      where: { id: req.params.id },
      data,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/properties/:id
// POST /api/properties/:id/merge — fold a duplicate property into another one.
// Everything attached to the source (utility accounts and their statements,
// units and leases, expenses, loans, insurance, taxes, improvements, legal
// matters, documents, insights, matched bank transactions) is re-pointed at
// the target, then the now-empty source is deleted. Nothing is lost and the
// target keeps its own name, address and valuation.
router.post('/:id/merge', async (req, res, next) => {
  try {
    const { targetId } = z.object({ targetId: z.string().min(1) }).parse(req.body);
    if (targetId === req.params.id) return res.status(400).json({ error: 'Pick a different property to merge into' });
    const [source, target] = await Promise.all([
      db.property.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } }),
      db.property.findFirst({ where: { id: targetId, userId: req.dbUserId! } }),
    ]);
    if (!source) return res.status(404).json({ error: 'Property not found' });
    if (!target) return res.status(404).json({ error: 'Target property not found' });

    const from = { propertyId: source.id };
    const to = { propertyId: target.id };
    const moved = await db.$transaction(async tx => {
      const counts = {
        utilityAccounts: (await tx.utilityAccount.updateMany({ where: from, data: to })).count,
        units: (await tx.unit.updateMany({ where: from, data: to })).count,
        expenses: (await tx.expense.updateMany({ where: from, data: to })).count,
        loans: (await tx.loan.updateMany({ where: from, data: to })).count,
        insurance: (await tx.insurancePolicy.updateMany({ where: from, data: to })).count,
        taxAssessments: (await tx.taxAssessment.updateMany({ where: from, data: to })).count,
        improvements: (await tx.improvement.updateMany({ where: from, data: to })).count,
        legalMatters: (await tx.legalMatter.updateMany({ where: from, data: to })).count,
        documents: (await tx.document.updateMany({ where: from, data: to })).count,
        insights: (await tx.aIInsight.updateMany({ where: from, data: to })).count,
        reconciliationProfiles: (await tx.reconciliationProfile.updateMany({ where: from, data: to })).count,
        outgoingTransactions: (await tx.outgoingTransaction.updateMany({ where: from, data: to })).count,
      };
      // Keep the duplicate's notes rather than dropping them on the floor.
      if (source.notes && source.notes.trim()) {
        await tx.property.update({
          where: { id: target.id },
          data: { notes: target.notes ? `${target.notes}\n\n— Merged from ${source.address}: ${source.notes}` : source.notes },
        });
      }
      await tx.property.delete({ where: { id: source.id } });
      return counts;
    });
    res.json({ ok: true, targetId: target.id, moved });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.property.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
    });
    if (!existing) return res.status(404).json({ error: 'Property not found' });

    await db.property.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
