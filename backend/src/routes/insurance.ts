import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { extractDeclarations } from '../services/declarationsExtractor';
import { uploadDocument } from '../services/s3Service';
import { findOrCreateUtilityAccount } from '../services/utilityAccountResolver';
import { reviewInsurance } from '../services/insuranceReview';

const router = Router();
router.use(attachDbUser);

const PolicySchema = z.object({
  propertyId: z.string(),
  carrier: z.string().min(1),
  policyNumber: z.string().optional().nullable(),
  policyType: z.enum(['PROPERTY','AUTO','RENTERS','LIABILITY','FLOOD','UMBRELLA','HEALTH','DENTAL','VISION','LIFE','BUSINESS','OTHER']).default('PROPERTY'),
  premiumAmount: z.number().positive(),
  premiumFrequency: z.enum(['MONTHLY','ANNUAL','SEMI_ANNUAL']).default('ANNUAL'),
  effectiveDate: z.string().transform(s => new Date(s)).optional().nullable(),
  expirationDate: z.string().transform(s => new Date(s)).optional().nullable(),
  // A term total that differs from the installment — a policy quoted for the
  // year but paid monthly carries both.
  termPremium: z.number().nonnegative().optional().nullable(),
  downPayment: z.number().nonnegative().optional().nullable(),
  downPaymentDate: z.string().transform(s => new Date(s)).optional().nullable(),
  dwellingLimit: z.number().nonnegative().optional().nullable(),
  otherStructuresLimit: z.number().nonnegative().optional().nullable(),
  personalPropertyLimit: z.number().nonnegative().optional().nullable(),
  lossOfUseLimit: z.number().nonnegative().optional().nullable(),
  liabilityLimit: z.number().nonnegative().optional().nullable(),
  medicalPaymentsLimit: z.number().nonnegative().optional().nullable(),
  deductible: z.number().nonnegative().optional().nullable(),
  windHailDeductible: z.string().optional().nullable(),
  replacementCostBasis: z.string().optional().nullable(),
  agentName: z.string().optional().nullable(),
  agentPhone: z.string().optional().nullable(),
  agentEmail: z.string().optional().nullable(),
  namedInsured: z.string().optional().nullable(),
  mortgageePayee: z.string().optional().nullable(),
  documentUrl: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  isPersonal: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

router.get('/', async (req, res, next) => {
  try {
    const { propertyId, isPersonal, isActive } = req.query;
    const policies = await db.insurancePolicy.findMany({
      where: {
        property: { userId: req.dbUserId! },
        ...(propertyId ? { propertyId: propertyId as string } : {}),
        ...(isPersonal !== undefined ? { isPersonal: isPersonal === 'true' } : {}),
        ...(isActive !== undefined ? { isActive: isActive === 'true' } : {}),
      },
      include: { property: { select: { id: true, address: true, nickname: true } } },
      orderBy: { carrier: 'asc' },
    });
    res.json(policies);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = PolicySchema.parse(req.body);
    const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    const policy = await db.insurancePolicy.create({ data });
    res.status(201).json(policy);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const data = PolicySchema.partial().parse(req.body);
    const existing = await db.insurancePolicy.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Policy not found' });
    const policy = await db.insurancePolicy.update({ where: { id: req.params.id }, data });
    res.json(policy);
  } catch (err) { next(err); }
});

// GET /review — coverage, gaps, underinsurance, renewals and premium changes across the portfolio.
router.get('/review', async (req, res, next) => {
  try { res.json(await reviewInsurance(req.dbUserId!)); } catch (err) { next(err); }
});

// ─── Claims ──────────────────────────────────────────────────────────────────
const day = z.string().nullable().optional().transform(v => (v ? new Date(v.slice(0, 10) + 'T12:00:00Z') : v === null ? null : undefined));
const ClaimSchema = z.object({
  propertyId: z.string(),
  policyId: z.string().optional().nullable(),
  claimNumber: z.string().max(80).optional().nullable(),
  dateOfLoss: day, reportedOn: day,
  cause: z.enum(['FIRE', 'WATER', 'WIND', 'HAIL', 'FLOOD', 'THEFT', 'VANDALISM', 'LIABILITY', 'OTHER']).default('OTHER'),
  description: z.string().max(4000).optional().nullable(),
  status: z.enum(['OPEN', 'IN_REVIEW', 'APPROVED', 'PAID', 'DENIED', 'CLOSED']).default('OPEN'),
  amountClaimed: z.number().nonnegative().optional().nullable(),
  amountPaid: z.number().nonnegative().optional().nullable(),
  deductibleApplied: z.number().nonnegative().optional().nullable(),
  adjusterName: z.string().max(200).optional().nullable(),
  adjusterPhone: z.string().max(40).optional().nullable(),
  adjusterEmail: z.string().max(200).optional().nullable(),
  nextStep: z.string().max(500).optional().nullable(),
  nextStepDate: day,
  notes: z.string().max(4000).optional().nullable(),
});
async function claimRefsOk(userId: string, d: { propertyId?: string; policyId?: string | null }) {
  if (d.propertyId && !(await db.property.findFirst({ where: { id: d.propertyId, userId }, select: { id: true } }))) return 'Property not found';
  if (d.policyId && !(await db.insurancePolicy.findFirst({ where: { id: d.policyId, property: { userId } }, select: { id: true } }))) return 'Policy not found';
  return null;
}

router.get('/claims', async (req, res, next) => {
  try {
    const claims = await db.insuranceClaim.findMany({
      where: { property: { userId: req.dbUserId! }, ...(req.query.propertyId ? { propertyId: String(req.query.propertyId) } : {}) },
      include: { property: { select: { id: true, address: true, nickname: true } } },
      orderBy: [{ dateOfLoss: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(claims);
  } catch (err) { next(err); }
});
router.post('/claims', async (req, res, next) => {
  try {
    const data = ClaimSchema.parse(req.body);
    const bad = await claimRefsOk(req.dbUserId!, data);
    if (bad) return res.status(404).json({ error: bad });
    res.status(201).json(await db.insuranceClaim.create({ data }));
  } catch (err) { next(err); }
});
router.patch('/claims/:id', async (req, res, next) => {
  try {
    const data = ClaimSchema.partial().parse(req.body);
    const existing = await db.insuranceClaim.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Claim not found' });
    const bad = await claimRefsOk(req.dbUserId!, data);
    if (bad) return res.status(404).json({ error: bad });
    res.json(await db.insuranceClaim.update({ where: { id: existing.id }, data }));
  } catch (err) { next(err); }
});
router.delete('/claims/:id', async (req, res, next) => {
  try {
    const existing = await db.insuranceClaim.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Claim not found' });
    await db.insuranceClaim.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.insurancePolicy.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Policy not found' });
    await db.insurancePolicy.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});



/**
 * POST /api/insurance/import-declarations
 *
 * One upload, three destinations — the places a policy has to appear:
 *   1. Portfolio → Insurance: the policy itself, with coverage and term.
 *   2. Utilities: an INSURANCE account, so the premium is a tracked bill with
 *      the right cadence rather than a number nobody is reminded about.
 *   3. Documents: the declarations page, attached to the property.
 *
 * The two records are deliberately linked, and pnl.ts takes the cost from the
 * account's statements when they exist so nothing is counted twice.
 */
router.post('/import-declarations', async (req, res, next) => {
  try {
    const { propertyId, fileData, filename } = req.body as {
      propertyId?: string; fileData?: string; filename?: string;
    };
    if (!propertyId || !fileData) {
      return res.status(400).json({ error: 'propertyId and fileData are required.' });
    }

    const property = await db.property.findFirst({
      where: { id: propertyId, userId: req.dbUserId! },
      select: { id: true, address: true },
    });
    if (!property) return res.status(404).json({ error: 'Property not found' });

    const buffer = Buffer.from(fileData, 'base64');
    const extracted = await extractDeclarations(buffer, filename || 'declarations.pdf');

    const carrier = extracted.carrier?.trim() || 'Unknown carrier';

    // Cadence describes the same fact as premiumFrequency, from the account's
    // side. A term total paid in installments bills at the installment
    // frequency, not once a term.
    const cadence = extracted.premiumFrequency === 'MONTHLY' ? 'MONTHLY'
      : extracted.premiumFrequency === 'SEMI_ANNUAL' ? 'SEMI_ANNUAL'
      : 'ANNUAL';

    const account = await findOrCreateUtilityAccount({
      propertyId: property.id,
      providerName: carrier,
      category: 'INSURANCE',
      accountNumber: extracted.policyNumber,
    });

    await db.utilityAccount.update({
      where: { id: account.id },
      data: {
        billingCadence: cadence as any,
        expectedAmount: extracted.premiumAmount ?? undefined,
      },
    });

    // Store the declarations page itself: the extraction is a reading of the
    // document, and the document is the record.
    let s3Key: string | null = null;
    try {
      const key = `${req.dbUserId}/documents/${property.id}/${Date.now()}_declarations.pdf`;
      await uploadDocument(key, buffer);
      s3Key = key;
      await db.document.create({
        data: {
          userId: req.dbUserId!,
          propertyId: property.id,
          category: 'INSURANCE' as any,
          title: `${carrier} declarations${extracted.policyNumber ? ` — ${extracted.policyNumber}` : ''}`,
          s3Key: key,
        },
      });
    } catch (err) {
      // A failed upload must not lose the extraction: the policy data is the
      // point, the filing is a convenience.
      console.error('[Declarations] Document upload failed:', err instanceof Error ? err.message : err);
    }

    const policyData = {
      carrier,
      policyNumber: extracted.policyNumber,
      policyType: (extracted.policyType ?? 'PROPERTY') as any,
      premiumAmount: extracted.premiumAmount ?? 0,
      premiumFrequency: cadence as any,
      termPremium: extracted.termPremium,
      effectiveDate: extracted.effectiveDate ? new Date(extracted.effectiveDate) : null,
      expirationDate: extracted.expirationDate ? new Date(extracted.expirationDate) : null,
      dwellingLimit: extracted.dwellingLimit,
      otherStructuresLimit: extracted.otherStructuresLimit,
      personalPropertyLimit: extracted.personalPropertyLimit,
      lossOfUseLimit: extracted.lossOfUseLimit,
      liabilityLimit: extracted.liabilityLimit,
      medicalPaymentsLimit: extracted.medicalPaymentsLimit,
      deductible: extracted.deductible,
      windHailDeductible: extracted.windHailDeductible,
      replacementCostBasis: extracted.replacementCostBasis,
      agentName: extracted.agentName,
      agentPhone: extracted.agentPhone,
      agentEmail: extracted.agentEmail,
      namedInsured: extracted.namedInsured,
      mortgageePayee: extracted.mortgageePayee,
      notes: extracted.notes,
    };

    // Upsert on the account link: re-uploading a renewal updates the policy in
    // place rather than leaving two records for the same coverage.
    const existing = await db.insurancePolicy.findUnique({
      where: { utilityAccountId: account.id },
      select: { id: true },
    });
    const policy = existing
      ? await db.insurancePolicy.update({ where: { id: existing.id }, data: policyData })
      : await db.insurancePolicy.create({
          data: { ...policyData, propertyId: property.id, utilityAccountId: account.id },
        });

    res.status(201).json({
      policy,
      utilityAccountId: account.id,
      accountCreated: account.created,
      documentStored: s3Key != null,
      extracted,
    });
  } catch (err) { next(err); }
});

export default router;
