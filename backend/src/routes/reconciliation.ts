import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument, getSignedDocumentUrl, detectContentType } from '../services/s3Service';
import { readManagerStatement } from '../services/managerStatement';
import { applyManagerStatement, lineItemsFrom, learnLineRules } from '../services/managerStatementApply';
import { fetchManagerStatements } from '../services/managerStatementFetch';
import { undoManagerStatement, redoManagerStatements, deleteManagerStatement, startOverManager, recordStatementAgain } from '../services/managerStatementRedo';

const router = Router();
router.use(attachDbUser);

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

const ProfileSchema = z.object({
  name: z.string().min(1),
  propertyId: z.string().optional().nullable(),
  leaseId: z.string().optional().nullable(),
  managementFeeCategory: z.string().optional().nullable(),
  loanIds: z.array(z.string()).default([]),
  notes: z.string().optional().nullable(),
  // The addresses the manager emails statements from: a PDF from one of them is read as this manager's statement.
  emailFrom: z.string().max(500).optional().nullable().transform(v => (v == null ? v : v.split(/[,\s;]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).join(', ') || null)),
});

const LineItemSchema = z.object({
  type: z.enum(['RENT', 'LOAN_PAYMENT', 'EXPENSE', 'OTHER']),
  targetId: z.string().optional().nullable(),
  targetLabel: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  amount: z.number(),
  direction: z.enum(['CREDIT', 'DEBIT']),
  // The actual date this line hit the account (e.g. rent received 8/8, but
  // loan payments/mgmt fee deducted 8/3) — falls back to statementDate
  // when not set, so older statements without per-item dates still work.
  date: z.string().optional().nullable(),
  // Read statements carry each cost's category and property (a manager may
  // cover several), and lines the owner left out (already recorded, a draw).
  category: z.string().optional().nullable(),
  propertyId: z.string().optional().nullable(),
  include: z.boolean().optional(),
});

const StatementSchema = z.object({
  profileId: z.string(),
  statementDate: z.string().transform(s => new Date(s)),
  lineItems: z.array(LineItemSchema).min(1),
  notes: z.string().optional().nullable(),
});

// ── Profiles ────────────────────────────────────────────────
router.get('/profiles', async (req, res, next) => {
  try {
    const profiles = await db.reconciliationProfile.findMany({
      where: { userId: req.dbUserId! },
      include: { property: { select: { id: true, address: true, nickname: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json(profiles);
  } catch (err) { next(err); }
});

router.post('/profiles', async (req, res, next) => {
  try {
    const data = ProfileSchema.parse(req.body);
    if (data.propertyId) {
      const prop = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }
    const profile = await db.reconciliationProfile.create({ data: { ...data, userId: req.dbUserId! } });
    res.status(201).json(profile);
  } catch (err) { next(err); }
});

router.patch('/profiles/:id', async (req, res, next) => {
  try {
    const data = ProfileSchema.partial().parse(req.body);
    const existing = await db.reconciliationProfile.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    const profile = await db.reconciliationProfile.update({ where: { id: req.params.id }, data });
    res.json(profile);
  } catch (err) { next(err); }
});

router.delete('/profiles/:id', async (req, res, next) => {
  try {
    const existing = await db.reconciliationProfile.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    await db.reconciliationProfile.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── Statements ──────────────────────────────────────────────
router.get('/statements', async (req, res, next) => {
  try {
    const { profileId } = req.query;
    const statements = await db.reconciliationStatement.findMany({
      where: { userId: req.dbUserId!, ...(profileId ? { profileId: profileId as string } : {}) },
      include: { profile: { select: { id: true, name: true, emailFrom: true } } },
      orderBy: { statementDate: 'desc' },
    });
    res.json(statements);
  } catch (err) { next(err); }
});

router.post('/statements', async (req, res, next) => {
  try {
    const data = StatementSchema.parse(req.body);
    const profile = await db.reconciliationProfile.findFirst({ where: { id: data.profileId, userId: req.dbUserId! } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const netAmount = data.lineItems.reduce((s, li) => s + (li.direction === 'CREDIT' ? li.amount : -li.amount), 0);

    const statement = await db.reconciliationStatement.create({
      data: {
        userId: req.dbUserId!,
        profileId: data.profileId,
        statementDate: data.statementDate,
        lineItems: data.lineItems as unknown as Prisma.InputJsonValue,
        netAmount,
        notes: data.notes || null,
      },
    });
    res.status(201).json(statement);
  } catch (err) { next(err); }
});

// POST /api/reconciliation/statements/:id/document — attach the source PDF/image (base64 body)
router.post('/statements/:id/document', async (req, res, next) => {
  try {
    const statement = await db.reconciliationStatement.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!statement) return res.status(404).json({ error: 'Statement not found' });

    const { fileData, filename } = req.body as { fileData?: string; filename?: string };
    if (!fileData) return res.status(400).json({ error: 'fileData (base64) is required' });

    const buffer = Buffer.from(fileData, 'base64');
    const key = `${req.dbUserId}/reconciliation/${statement.profileId}/${statement.id}/${sanitizeFilename(filename || 'statement.pdf')}`;
    const documentUrl = await uploadDocument(key, buffer);

    const updated = await db.reconciliationStatement.update({
      where: { id: req.params.id },
      data: { documentS3Key: key, documentUrl },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /api/reconciliation/statements/:id/apply — creates the real
// RentPayment/LoanPayment/Expense records this statement's line items
// represent, in one transaction. A statement can only be applied once.
router.post('/statements/:id/apply', async (req, res, next) => {
  try {
    await applyManagerStatement(req.dbUserId!, req.params.id);
    res.json(await db.reconciliationStatement.findUnique({ where: { id: req.params.id } }));
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /statements/:id/undo — remove what a statement recorded; it stays listed (as Undone) so its email is not fetched again.
router.post('/statements/:id/undo', async (req, res, next) => {
  try { await undoManagerStatement(req.dbUserId!, req.params.id); res.json({ ok: true }); }
  catch (err: any) { if (err?.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// POST /statements/:id/record-again — one statement recorded again from its lines (an undone one, or to refresh it).
router.post('/statements/:id/record-again', async (req, res, next) => {
  try { res.json(await recordStatementAgain(req.dbUserId!, req.params.id)); }
  catch (err: any) { if (err?.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// POST /profiles/:id/redo — record every emailed statement from this manager again, oldest first,
// with what has been chosen since; PDFs that are not statements are set aside.
router.post('/profiles/:id/redo', async (req, res, next) => {
  try {
    const p = await db.reconciliationProfile.findFirst({ where: { id: req.params.id, userId: req.dbUserId! }, select: { id: true } });
    if (!p) return res.status(404).json({ error: 'Manager not found' });
    res.json(await redoManagerStatements(req.dbUserId!, p.id));
  } catch (err) { next(err); }
});

// POST /profiles/:id/start-over — delete every statement from this manager with what it recorded,
// then fetch them from email again and record each afresh (services/managerStatementRedo.ts).
router.post('/profiles/:id/start-over', async (req, res, next) => {
  try {
    const p = await db.reconciliationProfile.findFirst({ where: { id: req.params.id, userId: req.dbUserId! }, select: { id: true } });
    if (!p) return res.status(404).json({ error: 'Manager not found' });
    res.json(await startOverManager(req.dbUserId!, p.id));
  } catch (err) { next(err); }
});

// POST /profiles/:id/merge { intoId } — two managers that are one (a person and the company their statements are
// headed with): statements, remembered choices and sending addresses move to intoId, which keeps both names, and
// its emailed statements are recorded again so nothing is counted twice.
router.post('/profiles/:id/merge', async (req, res, next) => {
  try {
    const { intoId } = z.object({ intoId: z.string() }).parse(req.body);
    const userId = req.dbUserId!;
    const [from, into] = await Promise.all([
      db.reconciliationProfile.findFirst({ where: { id: req.params.id, userId } }),
      db.reconciliationProfile.findFirst({ where: { id: intoId, userId } }),
    ]);
    if (!from || !into || from.id === into.id) return res.status(404).json({ error: 'Manager not found' });
    const obj = (j: unknown) => (j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : {});
    const addrs = [...new Set([into.emailFrom, from.emailFrom].flatMap(a => (a ?? '').split(/[,\s;]+/)).filter(a => a.includes('@')))];
    const names = into.name.toLowerCase().includes(from.name.toLowerCase()) ? into.name : `${into.name} · ${from.name}`;
    await db.$transaction([
      db.reconciliationStatement.updateMany({ where: { profileId: from.id, userId }, data: { profileId: into.id } }),
      db.reconciliationProfile.update({ where: { id: into.id }, data: {
        name: names.slice(0, 190), emailFrom: addrs.join(', ') || null, propertyId: into.propertyId ?? from.propertyId,
        // The kept manager's choices win; the other's fill in what it had not chosen.
        lineRules: { ...obj(from.lineRules), ...obj(into.lineRules) } as Prisma.InputJsonValue,
        loanIds: [...new Set([...((into.loanIds as string[] | null) ?? []), ...((from.loanIds as string[] | null) ?? [])])] as unknown as Prisma.InputJsonValue,
      } }),
      db.reconciliationProfile.delete({ where: { id: from.id } }),
    ]);
    res.json(await redoManagerStatements(userId, into.id));
  } catch (err) { next(err); }
});

// POST /statements/:id/review { lines } — an emailed statement reviewed: what was chosen is remembered
// for the manager, and every emailed statement from them is recorded again with it.
router.post('/statements/:id/review', async (req, res, next) => {
  try {
    const st = await db.reconciliationStatement.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!st) return res.status(404).json({ error: 'Statement not found' });
    const { lines } = z.object({ lines: ImportSchema.shape.lines }).parse(req.body);
    await learnLineRules(st.profileId, lines);
    res.json(await redoManagerStatements(req.dbUserId!, st.profileId));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Some lines are incomplete.' });
    next(err);
  }
});

// POST /api/reconciliation/fetch-email — look through the connected Gmail (the last 6 months)
// for manager statements now, and record the ones not fetched yet.
router.post('/fetch-email', async (req, res, next) => {
  try {
    const days = Math.min(400, Math.max(7, Number(req.body?.days) || 180));
    res.json(await fetchManagerStatements(req.dbUserId!, days));
  } catch (err) { next(err); }
});

// ── Reading a statement ──────────────────────────────────────
// POST /api/reconciliation/read { fileData (base64), filename } — the
// statement read into lines and matched to properties, leases and loans
// (services/managerStatement.ts). The file is kept under the owner's
// folder so the statement saved from this draft carries it.
router.post('/read', async (req, res, next) => {
  try {
    const { fileData, filename } = z.object({ fileData: z.string().min(1), filename: z.string().max(200).default('statement.pdf') }).parse(req.body);
    const buffer = Buffer.from(fileData, 'base64');
    if (buffer.length > 25 * 1024 * 1024) return res.status(400).json({ error: 'That file is over 25 MB.' });
    const type = detectContentType(buffer, filename);
    if (!/^(application\/pdf|image\/)/.test(type)) return res.status(400).json({ error: 'Upload the statement as a PDF or a photo.' });
    const draft = await readManagerStatement(req.dbUserId!, buffer, filename);
    const documentKey = `${req.dbUserId}/reconciliation/uploads/${Date.now()}-${sanitizeFilename(filename)}`;
    await uploadDocument(documentKey, buffer);
    res.json({ ...draft, documentKey });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

const ImportSchema = z.object({
  profileId: z.string().optional().nullable(),
  managerName: z.string().min(1).max(120),
  statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  documentKey: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  /** The emailed draft this review replaces (it keeps where it came from, so the email is not fetched again). */
  replaceId: z.string().optional().nullable(),
  lines: z.array(z.object({
    date: z.string().nullable().optional(), description: z.string().max(300), kind: z.string(), amount: z.number().positive(),
    direction: z.enum(['IN', 'OUT']), propertyId: z.string().nullable().optional(), leaseId: z.string().nullable().optional(),
    loanId: z.string().nullable().optional(), category: z.string().nullable().optional(), bankAccountId: z.string().nullable().optional(), include: z.boolean(),
    splits: z.array(z.object({ loanId: z.string(), amount: z.number().positive() })).max(6).nullable().optional(),
  })).min(1).max(500),
});

// POST /api/reconciliation/import — save a reviewed draft as a statement
// (under the manager's profile, made if new) and apply it: the rent,
// loan payments and costs it records become the owner's records.
router.post('/import', async (req, res, next) => {
  try {
    const d = ImportSchema.parse(req.body);
    const userId = req.dbUserId!;
    if (d.documentKey && !d.documentKey.startsWith(`${userId}/reconciliation/uploads/`)) return res.status(400).json({ error: 'That file is not yours.' });
    // Every record a line points at must be the owner's.
    const ids = (k: 'propertyId' | 'leaseId' | 'loanId') => [...new Set(d.lines.filter(l => l.include).map(l => l[k]).filter((x): x is string => !!x))];
    const [props, leases, loans] = await Promise.all([
      db.property.count({ where: { userId, id: { in: ids('propertyId') } } }),
      db.lease.count({ where: { unit: { property: { userId } }, id: { in: ids('leaseId') } } }),
      db.loan.count({ where: { userId, id: { in: ids('loanId') } } }),
    ]);
    if (props !== ids('propertyId').length || leases !== ids('leaseId').length || loans !== ids('loanId').length) return res.status(400).json({ error: 'A line points at a record that is not yours.' });
    for (const l of d.lines.filter(l => l.include)) {
      if (l.kind === 'RENT' && !l.leaseId) return res.status(400).json({ error: `Choose the lease for "${l.description}", or leave it out.` });
      if (l.kind === 'LOAN_PAYMENT' && !l.loanId) return res.status(400).json({ error: `Choose the loan for "${l.description}", or leave it out.` });
      if (['MANAGEMENT_FEE', 'REPAIR', 'UTILITY', 'OTHER_EXPENSE', 'REIMBURSEMENT'].includes(l.kind) && !l.propertyId) return res.status(400).json({ error: `Choose the property for "${l.description}", or leave it out.` });
    }

    // A reviewed emailed statement stays with its manager, whatever name the statement is headed with.
    const reviewedOf = d.replaceId ? await db.reconciliationStatement.findFirst({ where: { id: d.replaceId, userId }, select: { profileId: true } }) : null;
    let profile = reviewedOf ? await db.reconciliationProfile.findFirst({ where: { id: reviewedOf.profileId, userId } }) : null;
    profile ??= d.profileId ? await db.reconciliationProfile.findFirst({ where: { id: d.profileId, userId } }) : null;
    if (!profile) {
      const only = ids('propertyId');
      profile = await db.reconciliationProfile.create({
        data: { userId, name: d.managerName, propertyId: only.length === 1 ? only[0] : null, managementFeeCategory: 'PROPERTY_MANAGEMENT', loanIds: ids('loanId') as unknown as Prisma.InputJsonValue },
      });
    }
    if (d.lines.some(l => l.bankAccountId) && await db.bankAccount.count({ where: { userId, id: { in: d.lines.map(l => l.bankAccountId).filter((x): x is string => !!x) } } })
      !== new Set(d.lines.map(l => l.bankAccountId).filter(Boolean)).size) return res.status(400).json({ error: 'A line points at a bank account that is not yours.' });
    const lineItems = lineItemsFrom(d.lines);
    // What was chosen here is how this manager's same lines are filled in next time.
    await learnLineRules(profile.id, d.lines);
    const net = lineItems.reduce((t, li) => t + (li.direction === 'CREDIT' ? li.amount : -li.amount), 0);
    // The emailed statement this review came from: a draft is replaced (keeping where it came from);
    // one already recorded keeps its records, and its lines left to review are now done.
    const from = d.replaceId ? await db.reconciliationStatement.findFirst({ where: { id: d.replaceId, userId } }) : null;
    const replaced = from && from.status !== 'APPLIED' ? from : null;
    const statement = await db.reconciliationStatement.create({
      data: {
        userId, profileId: profile.id, statementDate: new Date(`${d.statementDate}T00:00:00.000Z`),
        lineItems: lineItems as unknown as Prisma.InputJsonValue, netAmount: Math.round(net * 100) / 100, notes: d.notes ?? replaced?.notes ?? null,
        documentS3Key: d.documentKey ?? replaced?.documentS3Key ?? null,
        ...(replaced ? { source: replaced.source, sourceRef: replaced.sourceRef, receivedAt: replaced.receivedAt } : {}),
      },
    });
    if (replaced) await db.reconciliationStatement.delete({ where: { id: replaced.id } });
    else if (from?.draftJson && typeof from.draftJson === 'object') {
      await db.reconciliationStatement.update({ where: { id: from.id }, data: { draftJson: { ...(from.draftJson as Record<string, unknown>), needsLook: 0 } as Prisma.InputJsonValue } });
    }
    res.status(201).json({ id: statement.id, profileId: profile.id });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Some lines are incomplete.' });
    next(err);
  }
});

// GET /api/reconciliation/statements/:id/document — the statement file, through a signed link.
router.get('/statements/:id/document', async (req, res, next) => {
  try {
    const s = await db.reconciliationStatement.findFirst({ where: { id: req.params.id, userId: req.dbUserId! }, select: { documentS3Key: true } });
    if (!s?.documentS3Key) return res.status(404).json({ error: 'No file on this statement.' });
    res.json({ url: await getSignedDocumentUrl(s.documentS3Key) });
  } catch (err) { next(err); }
});

// DELETE /statements/:id — the statement and what it recorded (an emailed one can be fetched again).
router.delete('/statements/:id', async (req, res, next) => {
  try { await deleteManagerStatement(req.dbUserId!, req.params.id); res.status(204).send(); }
  catch (err: any) { if (err?.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

export default router;
