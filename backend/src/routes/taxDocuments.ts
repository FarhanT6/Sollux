/**
 * Income-tax paperwork, year by year: the returns filed (federal and each
 * state), the forms received that feed them (1098 mortgage interest per
 * loan, 1099s, W-2s, K-1s), W-9s, and payments to and from tax agencies.
 *
 * Two views are computed rather than kept: a checklist of what a year
 * should have (a 1098 for every mortgage, a return for every state with an
 * income tax where there is a property, estimated payments on their dates)
 * and a contractor report — who was paid $600 or more, whether their W-9
 * is on file, and whether their 1099-NEC was issued.
 *
 * Taxpayer IDs are never stored in full: the reader returns the last four
 * digits only and scrubs anything shaped like an SSN or EIN.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument, getSignedDocumentUrl } from '../services/s3Service';
import { readDocument, scrubTin } from '../services/documentReader';

const router = Router();
router.use(attachDbUser);

const day = z.string().nullable().optional().transform(s => (s ? new Date(s) : s === null ? null : undefined));
const File = z.object({ name: z.string(), data: z.string() });
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
const NO_INCOME_TAX = new Set(['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']);
const MORTGAGE_TYPES = ['MORTGAGE', 'HELOC', 'DSCR', 'COMMERCIAL', 'HARD_MONEY', 'SELLER_FINANCING'];
/** Contractor work reported on a 1099-NEC when a person is paid $600+ in a year. */
const CONTRACTOR_CATEGORIES = ['HANDYMAN', 'REPAIRS_MAINTENANCE', 'LANDSCAPING', 'CAPITAL_IMPROVEMENT', 'PROPERTY_MANAGEMENT', 'LEGAL'] as const;

const DocFields = z.object({
  taxYear: z.number().int().min(1990).max(2100),
  jurisdiction: z.string().regex(/^(FEDERAL|[A-Z]{2})$/).optional(),
  formType: z.string().min(1).max(20),
  direction: z.enum(['RECEIVED', 'FILED', 'ISSUED']).optional(),
  status: z.enum(['EXPECTED', 'RECEIVED', 'FILED']).optional(),
  issuerName: z.string().nullable().optional(),
  recipientName: z.string().nullable().optional(),
  businessName: z.string().nullable().optional(),
  entityType: z.string().nullable().optional(),
  tinLast4: z.string().regex(/^\d{4}$/).nullable().optional(),
  address: z.string().nullable().optional(),
  propertyId: z.string().nullable().optional(),
  loanId: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  federalWithheld: z.number().nullable().optional(),
  stateWithheld: z.number().nullable().optional(),
  refundOrDue: z.number().nullable().optional(),
  boxes: z.record(z.union([z.number(), z.string()])).nullable().optional(),
  filedDate: day, dueDate: day,
  notes: z.string().nullable().optional(),
  files: z.array(File).max(12).optional(),
});

const PaymentFields = z.object({
  taxYear: z.number().int().min(1990).max(2100),
  jurisdiction: z.string().regex(/^(FEDERAL|[A-Z]{2})$/).optional(),
  kind: z.enum(['ESTIMATED', 'BALANCE_DUE', 'EXTENSION', 'REFUND']),
  period: z.string().nullable().optional(),
  dueDate: day, paidDate: day,
  amount: z.number().nonnegative(),
  confirmation: z.string().nullable().optional(),
  method: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

async function checkRefs(userId: string, d: { propertyId?: string | null; loanId?: string | null }) {
  if (d.propertyId && !(await db.property.findFirst({ where: { id: d.propertyId, userId }, select: { id: true } }))) return 'Property not found';
  if (d.loanId && !(await db.loan.findFirst({ where: { id: d.loanId, userId }, select: { id: true } }))) return 'Loan not found';
  return null;
}

/** Nothing but the last four digits of a TIN is ever written. */
function clean<T extends Record<string, any>>(d: T): T {
  const out: any = { ...d };
  for (const k of ['issuerName', 'recipientName', 'businessName', 'address', 'notes']) if (typeof out[k] === 'string') out[k] = scrubTin(out[k]);
  if (out.boxes) out.boxes = Object.fromEntries(Object.entries(out.boxes).filter(([k]) => !/\b(ssn|tin|ein|itin)\b/i.test(k)).map(([k, v]) => [k, typeof v === 'string' ? scrubTin(v) : v]));
  return out;
}

async function storeFiles(userId: string, year: number, files?: { name: string; data: string }[]) {
  const out: { key: string; name: string }[] = [];
  for (const f of files ?? []) {
    const key = `${userId}/tax-documents/${year}/${Date.now()}_${sanitize(f.name)}`;
    await uploadDocument(key, Buffer.from(f.data, 'base64'));
    out.push({ key, name: f.name });
  }
  return out;
}

const norm = (s?: string | null) => (s ?? '').toLowerCase().replace(/\b(llc|inc|corp|co|company|ltd|dba)\b/g, '').replace(/[^a-z0-9]/g, '');

// GET /?year=2025 — the year's forms and payments.
router.get('/', async (req, res, next) => {
  try {
    const year = req.query.year ? Number(req.query.year) : undefined;
    const [documents, payments] = await Promise.all([
      db.taxDocument.findMany({
        where: { userId: req.dbUserId!, ...(year ? { taxYear: year } : {}) },
        include: { property: { select: { id: true, address: true, nickname: true } } },
        orderBy: [{ taxYear: 'desc' }, { jurisdiction: 'asc' }, { formType: 'asc' }],
      }),
      db.taxPayment.findMany({ where: { userId: req.dbUserId!, ...(year ? { taxYear: year } : {}) }, orderBy: [{ dueDate: 'asc' }, { paidDate: 'asc' }] }),
    ]);
    const years = await db.taxDocument.findMany({ where: { userId: req.dbUserId! }, distinct: ['taxYear'], select: { taxYear: true } });
    res.json({ documents, payments, years: years.map(y => y.taxYear).sort((a, b) => b - a) });
  } catch (err) { next(err); }
});

router.post('/read', async (req, res, next) => {
  try {
    const { files } = z.object({ files: z.array(File).min(1).max(12) }).parse(req.body);
    const result = await readDocument('tax_form', files, req.dbUserId!);
    // A 1098 names its lender; the loan it belongs to is the one with that lender.
    if (result.fields.formType === '1098' || result.fields.formType === '1098-E') {
      const loans = await db.loan.findMany({ where: { userId: req.dbUserId!, isActive: true }, select: { id: true, lender: true, propertyId: true } });
      const lender = norm(result.fields.issuerName);
      const byLender = loans.filter(l => lender && (norm(l.lender).includes(lender) || lender.includes(norm(l.lender))));
      const byProperty = result.match?.propertyId ? byLender.filter(l => l.propertyId === result.match!.propertyId) : byLender;
      const loan = (byProperty.length === 1 ? byProperty[0] : byLender.length === 1 ? byLender[0] : null);
      (result.fields as any).loanId = loan?.id ?? null;
      if (loan?.propertyId && !result.match?.propertyId) result.match = { confidence: 'medium', propertyId: loan.propertyId, propertyName: null };
    }
    res.json(result);
  } catch (err: any) {
    if (err?.message) return res.status(422).json({ error: err.message });
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { files, ...data } = DocFields.parse(req.body);
    const bad = await checkRefs(req.dbUserId!, data);
    if (bad) return res.status(404).json({ error: bad });
    const documents = await storeFiles(req.dbUserId!, data.taxYear, files);
    const doc = await db.taxDocument.create({ data: { ...(clean(data) as any), userId: req.dbUserId!, documents: documents.length ? documents : undefined } });
    res.status(201).json(doc);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const existing = await db.taxDocument.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const { files, ...data } = DocFields.partial().parse(req.body);
    const bad = await checkRefs(req.dbUserId!, data);
    if (bad) return res.status(404).json({ error: bad });
    const added = await storeFiles(req.dbUserId!, data.taxYear ?? existing.taxYear, files);
    const doc = await db.taxDocument.update({
      where: { id: existing.id },
      data: { ...(clean(data) as any), ...(added.length ? { documents: [...((existing.documents as any[]) ?? []), ...added] } : {}) },
    });
    res.json(doc);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.taxDocument.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await db.taxDocument.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

router.get('/:id/documents/:n', async (req, res, next) => {
  try {
    const existing = await db.taxDocument.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    const doc = ((existing?.documents as any[]) ?? [])[Number(req.params.n)];
    if (!existing || !doc) return res.status(404).json({ error: 'Not found' });
    res.json({ url: await getSignedDocumentUrl(doc.key), name: doc.name });
  } catch (err) { next(err); }
});

// ── Payments to and from tax agencies ───────────────────────────────────────
router.post('/payments', async (req, res, next) => {
  try {
    const data = PaymentFields.parse(req.body);
    res.status(201).json(await db.taxPayment.create({ data: { ...(data as any), userId: req.dbUserId! } }));
  } catch (err) { next(err); }
});
router.patch('/payments/:id', async (req, res, next) => {
  try {
    const existing = await db.taxPayment.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    res.json(await db.taxPayment.update({ where: { id: existing.id }, data: PaymentFields.partial().parse(req.body) as any }));
  } catch (err) { next(err); }
});
router.delete('/payments/:id', async (req, res, next) => {
  try {
    const existing = await db.taxPayment.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await db.taxPayment.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── What a year should have ─────────────────────────────────────────────────
router.get('/checklist', async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear() - 1;
    const userId = req.dbUserId!;
    const [docs, payments, loans, properties] = await Promise.all([
      db.taxDocument.findMany({ where: { userId, taxYear: year } }),
      db.taxPayment.findMany({ where: { userId, taxYear: year } }),
      db.loan.findMany({ where: { userId }, select: { id: true, lender: true, loanType: true, propertyId: true, isActive: true, isPersonal: true, originationDate: true, property: { select: { address: true, nickname: true } } } }),
      db.property.findMany({ where: { userId }, select: { state: true } }),
    ]);
    const has = (pred: (d: typeof docs[number]) => boolean) => docs.find(pred) ?? null;

    // A 1098 for every mortgage-type loan that existed in the year; a 1098-E for student loans.
    const endOfYear = new Date(Date.UTC(year, 11, 31));
    const forms = loans
      .filter(l => (MORTGAGE_TYPES.includes(l.loanType) || l.loanType === 'STUDENT') && (l.isActive || false) && (!l.originationDate || l.originationDate <= endOfYear))
      .map(l => {
        const formType = l.loanType === 'STUDENT' ? '1098-E' : '1098';
        const doc = has(d => d.formType === formType && (d.loanId === l.id || (!d.loanId && !!d.issuerName && (norm(d.issuerName).includes(norm(l.lender)) || norm(l.lender).includes(norm(d.issuerName))))));
        return { kind: 'FORM', formType, label: `${formType} from ${l.lender}${l.property ? ` — ${l.property.nickname || l.property.address}` : ''}`, loanId: l.id, propertyId: l.propertyId, documentId: doc?.id ?? null, done: !!doc };
      });

    // Returns: federal, California (home), and every state with an income tax where a property is.
    const states = new Set<string>(['CA']);
    for (const p of properties) if (p.state && !NO_INCOME_TAX.has(p.state.toUpperCase())) states.add(p.state.toUpperCase());
    const returnDue = `${year + 1}-04-15`;
    const returns = [
      { jurisdiction: 'FEDERAL', label: 'Federal return (Form 1040)' },
      ...[...states].sort().map(s => ({ jurisdiction: s, label: s === 'CA' ? 'California return (Form 540)' : `${s} return${s === 'WV' ? ' (IT-140, nonresident: rental income there)' : ''}` })),
    ].map(r => {
      const doc = has(d => d.direction === 'FILED' && d.jurisdiction === r.jurisdiction && !['1040-ES', 'NOTICE', 'W-9'].includes(d.formType));
      return { kind: 'RETURN', ...r, dueDate: returnDue, documentId: doc?.id ?? null, filedDate: doc?.filedDate ?? null, refundOrDue: doc?.refundOrDue ?? null, done: !!doc };
    });

    // Estimated payments for the year: federal four, California three (no Q3).
    const est = [
      ...[['Q1', `${year}-04-15`], ['Q2', `${year}-06-15`], ['Q3', `${year}-09-15`], ['Q4', `${year + 1}-01-15`]].map(([p, d]) => ({ jurisdiction: 'FEDERAL', period: p, dueDate: d })),
      ...(states.has('CA') ? [['Q1', `${year}-04-15`], ['Q2', `${year}-06-15`], ['Q4', `${year + 1}-01-15`]].map(([p, d]) => ({ jurisdiction: 'CA', period: p, dueDate: d })) : []),
    ].map(e => {
      const paid = payments.filter(p => p.kind === 'ESTIMATED' && p.jurisdiction === e.jurisdiction && p.period === e.period);
      return { ...e, paid: paid.reduce((t, p) => t + Number(p.amount), 0), paymentIds: paid.map(p => p.id) };
    });

    res.json({ year, forms, returns, estimatedPayments: est, statesWithIncomeTax: [...states].sort() });
  } catch (err) { next(err); }
});

// ── 1099-NEC: contractors paid $600+ and whether their W-9 is on file ───────
router.get('/contractors', async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear() - 1;
    const userId = req.dbUserId!;
    const [expenses, w9s, issued] = await Promise.all([
      db.expense.findMany({
        where: { userId, isPersonal: false, vendor: { not: null }, category: { in: CONTRACTOR_CATEGORIES as any }, date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
        select: { vendor: true, amount: true, category: true, propertyId: true },
      }),
      db.taxDocument.findMany({ where: { userId, formType: 'W-9', direction: 'RECEIVED' }, orderBy: { createdAt: 'desc' } }),
      db.taxDocument.findMany({ where: { userId, formType: '1099-NEC', direction: 'ISSUED', taxYear: year } }),
    ]);
    const groups = new Map<string, { vendor: string; total: number; count: number; categories: Set<string>; properties: Set<string> }>();
    for (const e of expenses) {
      const k = norm(e.vendor);
      if (!k) continue;
      const g = groups.get(k) ?? { vendor: e.vendor!, total: 0, count: 0, categories: new Set(), properties: new Set() };
      g.total += Number(e.amount); g.count++; g.categories.add(e.category); if (e.propertyId) g.properties.add(e.propertyId);
      groups.set(k, g);
    }
    const matchName = (d: { issuerName: string | null; businessName: string | null; recipientName: string | null }, k: string) =>
      [d.issuerName, d.businessName, d.recipientName].some(n => { const x = norm(n); return !!x && (x === k || x.includes(k) || k.includes(x)); });
    const rows = [...groups.entries()].map(([k, g]) => {
      const w9 = w9s.find(d => matchName(d, k)) ?? null;
      const form = issued.find(d => matchName(d, k)) ?? null;
      // Corporations do not get a 1099-NEC (attorneys excepted).
      const corporation = !!w9?.entityType && /corporation|c corp|s corp/i.test(w9.entityType) && !g.categories.has('LEGAL');
      const needs1099 = g.total >= 600 && !corporation;
      return {
        vendor: g.vendor, total: Number(g.total.toFixed(2)), payments: g.count, categories: [...g.categories], propertyCount: g.properties.size,
        needs1099, corporation,
        w9: w9 ? { id: w9.id, entityType: w9.entityType, tinLast4: w9.tinLast4, taxYear: w9.taxYear } : null,
        issued1099: form ? { id: form.id, amount: form.amount } : null,
      };
    }).sort((a, b) => b.total - a.total);
    res.json({ year, threshold: 600, contractors: rows, w9sOnFile: w9s.length });
  } catch (err) { next(err); }
});

export default router;
