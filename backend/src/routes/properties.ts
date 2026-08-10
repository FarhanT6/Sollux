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
  type: z.enum(['PRIMARY', 'RENTAL', 'INVESTMENT', 'COMMERCIAL', 'RESIDENTIAL_SINGLE', 'RESIDENTIAL_MULTI', 'LAND', 'GOLF_COURSE', 'OTHER']),
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
            lastSyncStatus: true,
            lastSyncedAt: true,
            statements: {
              orderBy: { statementDate: 'desc' },
              take: 1,
              select: { amountDue: true, dueDate: true, amountPaid: true, rawDataJson: true, statementDate: true },
            },
            // Recent payments so the PropertyCard can reconcile balance against
            // payments that haven't yet posted on the provider's API side.
            // Limit to the 5 most recent — enough to detect "paid in full".
            payments: {
              orderBy: { paymentDate: 'desc' },
              take: 5,
              select: { paymentDate: true, amount: true },
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
            payments: { orderBy: { paymentDate: 'desc' }, take: 6 },
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
