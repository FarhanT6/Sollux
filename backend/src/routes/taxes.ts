import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument, getSignedDocumentUrl } from '../services/s3Service';
import { readDocument } from '../services/documentReader';
import { calendarFor, defaultTimeline, redemptionEstimate, installmentStatus, isCommercial } from '../lib/propertyTaxRules';
import { Prisma } from '@prisma/client';

const router = Router();
router.use(attachDbUser);

const day = z.string().nullable().optional().transform(v => (v ? new Date(v.slice(0, 10) + 'T12:00:00Z') : v === null ? null : undefined));
const SpecialAssessment = z.object({ name: z.string().min(1).max(200), amount: z.number(), phone: z.string().max(40).optional().nullable(), cfd: z.boolean().optional() });
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const num = (v: unknown) => (v == null ? null : Number(v));
const todayIso = () => new Date().toISOString().slice(0, 10);

/** The schema's specialAssessments goes to the JSON column. */
function toRow<T extends { specialAssessments?: unknown }>(d: T) {
  const { specialAssessments, ...rest } = d;
  return { ...rest, ...(specialAssessments !== undefined ? { specialAssessmentsJson: (specialAssessments ?? Prisma.DbNull) as any } : {}) };
}

/**
 * The year's installments as the state runs them: due day, the day it turns
 * delinquent (the bill's own date first) and where it stands today, with the
 * penalty a delinquent one carries.
 */
function computedYear(t: any, state: string | null | undefined) {
  const cal = calendarFor(state, t.taxYear);
  const asOf = todayIso();
  const inst = [1, 2].map(n => {
    const rule = cal?.installments.find(i => i.n === n);
    const amount = num(t[`installment${n}Amount`]) ?? (n === 1 && cal?.installments.length === 1 ? num(t.annualTaxAmount) : null);
    const due = iso(t[`installment${n}Due`]) ?? rule?.due ?? null;
    const delinquentAfter = iso(t[`installment${n}Delinquent`]) ?? rule?.delinquentAfter ?? null;
    if (!due && !delinquentAfter && amount == null) return null;
    const paid = iso(t[`installment${n}Paid`]);
    const st = delinquentAfter
      ? installmentStatus({ n: n as 1 | 2, due: due ?? delinquentAfter, delinquentAfter, penaltyRate: rule?.penaltyRate ?? 0, cost: rule?.cost ?? 0 }, amount, paid, asOf)
      : { state: paid ? 'paid' : 'upcoming', penalty: 0 };
    return { n, amount, due, delinquentAfter, paid, ...st };
  }).filter(Boolean);
  const discount = cal?.discounts?.find(d => asOf <= d.by && !t.installment1Paid) ?? null;
  return { calendar: cal ? { yearLabel: cal.yearLabel, notes: cal.notes } : null, installments: inst, discount };
}

const TaxSchema = z.object({
  propertyId: z.string(),
  taxYear: z.string().min(1),
  assessedValue: z.number().optional().nullable(),
  annualTaxAmount: z.number().positive(),
  installment1Due: z.string().transform(s => new Date(s)).optional().nullable(),
  installment2Due: z.string().transform(s => new Date(s)).optional().nullable(),
  installment1Paid: z.string().transform(s => new Date(s)).optional().nullable(),
  installment2Paid: z.string().transform(s => new Date(s)).optional().nullable(),
  status: z.enum(['UNPAID','PAID','PARTIALLY_PAID','DELINQUENT']).default('UNPAID'),
  notes: z.string().optional().nullable(),
  apn: z.string().optional().nullable(),
  taxingAuthority: z.string().optional().nullable(),
  installment1Amount: z.number().nonnegative().optional().nullable(),
  installment2Amount: z.number().nonnegative().optional().nullable(),
  escrowLoanId: z.string().optional().nullable(),
  installment1Delinquent: day,
  installment2Delinquent: day,
  billNumber: z.string().optional().nullable(),
  landValue: z.number().optional().nullable(),
  improvementValue: z.number().optional().nullable(),
  marketValue: z.number().optional().nullable(),
  exemptionsValue: z.number().optional().nullable(),
  exemptionsNote: z.string().optional().nullable(),
  baseYear: z.string().optional().nullable(),
  taxRate: z.number().optional().nullable(),
  specialAssessments: z.array(SpecialAssessment).max(60).optional().nullable(),
  penaltiesOwed: z.number().optional().nullable(),
  balanceOwed: z.number().optional().nullable(),
  sourceUrl: z.string().url().optional().nullable(),
  /** The tax bill itself, stored and read back through a signed URL. */
  file: z.object({ name: z.string(), data: z.string() }).optional(),
});

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
async function storeBill(userId: string, propertyId: string, file?: { name: string; data: string }) {
  if (!file) return undefined;
  const key = `${userId}/taxes/${propertyId}/${Date.now()}_${sanitize(file.name)}`;
  await uploadDocument(key, Buffer.from(file.data, 'base64'));
  return key;
}
async function checkLoan(loanId: string | null | undefined, userId: string) {
  if (!loanId) return true;
  return !!(await db.loan.findFirst({ where: { id: loanId, userId }, select: { id: true } }));
}

router.get('/', async (req, res, next) => {
  try {
    const { propertyId } = req.query;
    const taxes = await db.taxAssessment.findMany({
      where: {
        property: { userId: req.dbUserId! },
        ...(propertyId ? { propertyId: propertyId as string } : {}),
      },
      include: { property: { select: { id: true, address: true, nickname: true, city: true, state: true, county: true } } },
      orderBy: [{ taxYear: 'desc' }],
    });
    res.json(taxes.map(({ documentS3Key, specialAssessmentsJson, ...t }) => ({
      ...t, specialAssessments: specialAssessmentsJson ?? null, hasDocument: !!documentS3Key, computed: computedYear(t, t.property?.state),
    })));
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { file, ...data } = TaxSchema.parse(req.body);
    const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    if (!(await checkLoan(data.escrowLoanId, req.dbUserId!))) return res.status(404).json({ error: 'Loan not found' });
    const documentS3Key = await storeBill(req.dbUserId!, data.propertyId, file);
    // One record per property and tax year: a second bill for the same year
    // (a supplemental, a corrected bill, a re-import) updates it.
    const tax = await db.taxAssessment.upsert({
      where: { propertyId_taxYear: { propertyId: data.propertyId, taxYear: data.taxYear } },
      create: { ...toRow(data), ...(documentS3Key ? { documentS3Key } : {}) } as any,
      update: { ...toRow(data), ...(documentS3Key ? { documentS3Key } : {}) } as any,
    });
    if (data.apn) await db.property.updateMany({ where: { id: data.propertyId, apn: null }, data: { apn: data.apn } });
    res.status(201).json(tax);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { file, ...data } = TaxSchema.partial().parse(req.body);
    const existing = await db.taxAssessment.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Tax assessment not found' });
    if (data.propertyId && !(await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } }))) return res.status(404).json({ error: 'Property not found' });
    if (!(await checkLoan(data.escrowLoanId, req.dbUserId!))) return res.status(404).json({ error: 'Loan not found' });
    const documentS3Key = await storeBill(req.dbUserId!, data.propertyId ?? existing.propertyId, file);
    const tax = await db.taxAssessment.update({ where: { id: req.params.id }, data: { ...toRow(data), ...(documentS3Key ? { documentS3Key } : {}) } as any });
    res.json(tax);
  } catch (err) { next(err); }
});

// POST /read — the fields of a tax bill from its pages, and its property; saves nothing.
router.post('/read', async (req, res, next) => {
  try {
    const { files } = z.object({ files: z.array(z.object({ name: z.string(), data: z.string() })).min(1).max(12) }).parse(req.body);
    const result = await readDocument('tax_bill', files, req.dbUserId!);
    // The parcel number identifies a property better than its address.
    if (result.fields.apn && (!result.match || result.match.confidence !== 'high')) {
      const digits = String(result.fields.apn).replace(/\D/g, '');
      const known = digits.length >= 6 ? await db.taxAssessment.findMany({
        where: { property: { userId: req.dbUserId! }, apn: { not: null } },
        select: { apn: true, property: { select: { id: true, address: true, nickname: true } } },
      }) : [];
      const prior = known.find(k => (k.apn ?? '').replace(/\D/g, '') === digits);
      if (prior) {
        result.match = { confidence: 'high', propertyId: prior.property.id, propertyName: prior.property.nickname || prior.property.address };
      }
    }
    res.json(result);
  } catch (err: any) {
    if (err?.message) return res.status(422).json({ error: err.message });
    next(err);
  }
});

router.get('/:id/document', async (req, res, next) => {
  try {
    const existing = await db.taxAssessment.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing?.documentS3Key) return res.status(404).json({ error: 'No tax bill attached' });
    res.json({ url: await getSignedDocumentUrl(existing.documentS3Key) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.taxAssessment.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Tax assessment not found' });
    await db.taxAssessment.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Years left unpaid: defaults, certificates, liens ─────────────────────────

const DefaultSchema = z.object({
  propertyId: z.string(),
  taxYear: z.string().min(1).max(20),
  status: z.enum(['OPEN', 'PLAN', 'REDEEMED', 'SOLD']).default('OPEN'),
  defaultNumber: z.string().max(60).optional().nullable(),
  defaultDate: day,
  taxAmount: z.number().nonnegative().optional().nullable(),
  penalties: z.number().nonnegative().optional().nullable(),
  costs: z.number().nonnegative().optional().nullable(),
  amountToRedeem: z.number().nonnegative().optional().nullable(),
  redeemGoodThrough: day,
  powerToSellDate: day,
  payPlan: z.object({
    started: z.string().nullable().optional(), installment: z.number().nullable().optional(), nextDue: z.string().nullable().optional(),
    remaining: z.number().int().nullable().optional(), balance: z.number().nullable().optional(),
  }).optional().nullable(),
  certificateNumber: z.string().max(60).optional().nullable(),
  certificateHolder: z.string().max(200).optional().nullable(),
  certificateRate: z.number().min(0).max(100).optional().nullable(),
  certificateIssued: day,
  redeemedOn: day,
  notes: z.string().max(2000).optional().nullable(),
  sourceUrl: z.string().url().optional().nullable(),
});
const defaultRow = <T extends { payPlan?: unknown }>(d: T) => {
  const { payPlan, ...rest } = d;
  return { ...rest, ...(payPlan !== undefined ? { payPlanJson: (payPlan ?? Prisma.DbNull) as any } : {}) };
};

/** What the state's rules add to a defaulted year: its timeline and, where the rules say how, today's redemption estimate. */
function computedDefault(d: any, property: { state?: string | null; type?: string | null }) {
  const tl = defaultTimeline(property.state, d.taxYear, { defaultDate: iso(d.defaultDate), certificateIssued: iso(d.certificateIssued) });
  const tax = num(d.taxAmount);
  const est = tax != null && (tl?.defaultDate || d.defaultDate)
    ? redemptionEstimate(property.state, { tax, penalties: num(d.penalties), costs: num(d.costs), defaultDate: iso(d.defaultDate) ?? tl!.defaultDate! }, todayIso())
    : null;
  const commercial = isCommercial(property.type);
  return {
    timeline: tl,
    // The county's own figure while it holds; the estimate after.
    redemption: est,
    stated: num(d.amountToRedeem) != null && (!d.redeemGoodThrough || iso(d.redeemGoodThrough)! >= todayIso()) ? num(d.amountToRedeem) : null,
    powerToSell: iso(d.powerToSellDate) ?? (commercial ? tl?.powerToSellCommercial : tl?.powerToSell) ?? tl?.deedEligible ?? null,
    commercial,
  };
}

router.get('/defaults', async (req, res, next) => {
  try {
    const { propertyId } = req.query;
    const rows = await db.taxDefault.findMany({
      where: { property: { userId: req.dbUserId! }, ...(propertyId ? { propertyId: String(propertyId) } : {}) },
      include: { property: { select: { id: true, address: true, nickname: true, state: true, county: true, type: true } } },
      orderBy: [{ taxYear: 'asc' }],
    });
    res.json(rows.map(({ payPlanJson, ...d }) => ({ ...d, payPlan: payPlanJson ?? null, computed: computedDefault(d, d.property) })));
  } catch (err) { next(err); }
});

router.post('/defaults', async (req, res, next) => {
  try {
    const data = DefaultSchema.parse(req.body);
    const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! }, select: { id: true } });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    const row = await db.taxDefault.upsert({
      where: { propertyId_taxYear: { propertyId: data.propertyId, taxYear: data.taxYear } },
      create: defaultRow(data) as any, update: defaultRow(data) as any,
    });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.patch('/defaults/:id', async (req, res, next) => {
  try {
    const data = DefaultSchema.partial().parse(req.body);
    const existing = await db.taxDefault.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (data.propertyId && !(await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } }))) return res.status(404).json({ error: 'Property not found' });
    res.json(await db.taxDefault.update({ where: { id: existing.id }, data: defaultRow(data) as any }));
  } catch (err) { next(err); }
});

router.delete('/defaults/:id', async (req, res, next) => {
  try {
    const existing = await db.taxDefault.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await db.taxDefault.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /lookup { propertyId } — look the parcel up on the county's tax site (in the background).
router.post('/lookup', async (req, res, next) => {
  try {
    const { propertyId } = z.object({ propertyId: z.string() }).parse(req.body);
    const p = await db.property.findFirst({ where: { id: propertyId, userId: req.dbUserId! }, select: { id: true, apn: true, state: true, county: true, taxLookupJson: true } });
    if (!p) return res.status(404).json({ error: 'Property not found' });
    if (!p.state) return res.status(400).json({ error: 'Add the property\'s state (and county) first.' });
    const s = p.taxLookupJson as { status?: string; at?: string } | null;
    // One at a time; a run stuck for over 20 minutes may be started again.
    if ((s?.status === 'queued' || s?.status === 'running') && s.at && Date.now() - new Date(s.at).getTime() < 20 * 60_000) return res.status(409).json({ error: 'A lookup is already running for this property.' });
    const { checkBudget, withAiContext } = await import('../ai/meter');
    try { await withAiContext({ userId: req.dbUserId! }, () => checkBudget('tax-lookup')); }
    catch (err) { return res.status(402).json({ error: err instanceof Error ? err.message : String(err) }); }
    const { queueTaxLookup } = await import('../services/taxLookupJobs');
    await queueTaxLookup(p.id);
    res.status(202).json({ queued: true });
  } catch (err) { next(err); }
});

// POST /lookup-all — every active property not looked up in the last week
// (and not already in progress): parcel numbers are found by address where
// none is on file.
router.post('/lookup-all', async (req, res, next) => {
  try {
    // Nothing is queued that the AI budget would stop at once.
    const { checkBudget, withAiContext } = await import('../ai/meter');
    try { await withAiContext({ userId: req.dbUserId! }, () => checkBudget('tax-lookup')); }
    catch (err) { return res.status(402).json({ error: err instanceof Error ? err.message : String(err) }); }
    const props = await db.property.findMany({ where: { userId: req.dbUserId!, status: 'ACTIVE' }, select: { id: true, state: true, address: true, taxLookupJson: true } });
    const { queueTaxLookup } = await import('../services/taxLookupJobs');
    let queued = 0, skipped = 0;
    for (const p of props) {
      const s = p.taxLookupJson as { status?: string; at?: string } | null;
      const age = s?.at ? Date.now() - new Date(s.at).getTime() : Infinity;
      const busy = (s?.status === 'queued' || s?.status === 'running') && age < 20 * 60_000;
      const fresh = s?.status === 'done' && age < 7 * 24 * 3600_000;
      if (!p.state || !p.address || busy || fresh) { skipped++; continue; }
      await queueTaxLookup(p.id);
      queued++;
    }
    res.json({ queued, skipped });
  } catch (err) { next(err); }
});

// POST /lookup/cancel { propertyId? } — stop one property's lookup, or every one under way.
router.post('/lookup/cancel', async (req, res, next) => {
  try {
    const { propertyId } = z.object({ propertyId: z.string().optional() }).parse(req.body ?? {});
    const props = await db.property.findMany({ where: { userId: req.dbUserId!, ...(propertyId ? { id: propertyId } : {}) }, select: { id: true } });
    const { cancelTaxLookup } = await import('../services/taxLookupJobs');
    let cancelled = 0;
    for (const p of props) if (await cancelTaxLookup(p.id)) cancelled++;
    res.json({ cancelled });
  } catch (err) { next(err); }
});

// GET /lookup-status — where each property's last lookup stands.
router.get('/lookup-status', async (req, res, next) => {
  try {
    const rows = await db.property.findMany({ where: { userId: req.dbUserId! }, select: { id: true, taxLookupJson: true } });
    res.json(Object.fromEntries(rows.map(r => [r.id, r.taxLookupJson ?? null])));
  } catch (err) { next(err); }
});

// GET /rules?state=CA&taxYear=2026-27 — the state's calendar and what an unpaid year leads to.
router.get('/rules', (req, res) => {
  const state = String(req.query.state ?? ''); const taxYear = String(req.query.taxYear ?? '');
  res.json({ calendar: calendarFor(state, taxYear), timeline: defaultTimeline(state, taxYear) });
});

export default router;
