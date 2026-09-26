/**
 * Development projects funded from here but outside the rental portfolio —
 * a 10-story apartment building in Bangladesh — and the money sent to them.
 * Each transfer records what left in dollars, the fee, the exchange rate,
 * and what arrived in local currency, so the project's totals say both how
 * much it has cost in dollars and how much reached the site.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument, getSignedDocumentUrl } from '../services/s3Service';
import { readDocument } from '../services/documentReader';

const router = Router();
router.use(attachDbUser);

const day = z.string().nullable().optional().transform(s => (s ? new Date(s) : s === null ? null : undefined));
const File = z.object({ name: z.string(), data: z.string() });

const ProjectFields = z.object({
  name: z.string().min(1),
  country: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  localCurrency: z.string().min(3).max(3).optional(),
  budgetUsd: z.number().nonnegative().nullable().optional(),
  budgetLocal: z.number().nonnegative().nullable().optional(),
  floors: z.number().int().positive().nullable().optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETE']).optional(),
  startDate: day, targetDate: day,
  notes: z.string().nullable().optional(),
});

const TransferFields = z.object({
  date: z.string().transform(s => new Date(s)),
  amountUsd: z.number().positive(),
  feeUsd: z.number().nonnegative().nullable().optional(),
  exchangeRate: z.number().positive().nullable().optional(),
  amountLocal: z.number().nonnegative().nullable().optional(),
  method: z.string().nullable().optional(),
  recipient: z.string().nullable().optional(),
  purpose: z.string().nullable().optional(),
  bankAccountId: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  file: File.optional(),
});

const n = (v: unknown) => (v == null ? 0 : Number(v));
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);

/** What arrived, when the receipt gave a rate but not the amount. */
function localOf(t: { amountUsd: unknown; exchangeRate?: unknown; amountLocal?: unknown }): number | null {
  if (t.amountLocal != null) return n(t.amountLocal);
  if (t.exchangeRate != null) return Number((n(t.amountUsd) * n(t.exchangeRate)).toFixed(2));
  return null;
}

function totals(project: any) {
  const ts = project.transfers ?? [];
  const sentUsd = ts.reduce((t: number, x: any) => t + n(x.amountUsd), 0);
  const feesUsd = ts.reduce((t: number, x: any) => t + n(x.feeUsd), 0);
  const locals = ts.map(localOf);
  const receivedLocal = locals.reduce((t: number, v: number | null) => t + (v ?? 0), 0);
  const unknownLocal = locals.filter((v: number | null) => v == null).length;
  const byPurpose: Record<string, { usd: number; local: number; count: number }> = {};
  ts.forEach((x: any, i: number) => {
    const k = x.purpose || 'OTHER';
    byPurpose[k] ??= { usd: 0, local: 0, count: 0 };
    byPurpose[k].usd += n(x.amountUsd); byPurpose[k].local += locals[i] ?? 0; byPurpose[k].count++;
  });
  const r2 = (v: number) => Number(v.toFixed(2));
  return {
    sentUsd: r2(sentUsd), feesUsd: r2(feesUsd), totalCostUsd: r2(sentUsd + feesUsd),
    receivedLocal: r2(receivedLocal), transfersWithoutRate: unknownLocal,
    averageRate: sentUsd > 0 && unknownLocal === 0 ? Number((receivedLocal / sentUsd).toFixed(4)) : null,
    budgetUsedPct: project.budgetUsd ? r2((sentUsd / n(project.budgetUsd)) * 100) : project.budgetLocal ? r2((receivedLocal / n(project.budgetLocal)) * 100) : null,
    byPurpose: Object.fromEntries(Object.entries(byPurpose).map(([k, v]) => [k, { usd: r2(v.usd), local: r2(v.local), count: v.count }])),
    lastTransfer: ts.length ? ts[0].date : null,
  };
}

async function ownedProject(id: string, userId: string) {
  return db.developmentProject.findFirst({ where: { id, userId } });
}
async function ownedTransfer(id: string, userId: string) {
  return db.projectTransfer.findFirst({ where: { id, project: { userId } } });
}
async function checkBank(bankAccountId: string | null | undefined, userId: string) {
  if (!bankAccountId) return;
  const b = await db.bankAccount.findFirst({ where: { id: bankAccountId, userId }, select: { id: true } });
  if (!b) { const e: any = new Error('Bank account not found'); e.status = 404; throw e; }
}

router.get('/', async (req, res, next) => {
  try {
    const projects = await db.developmentProject.findMany({
      where: { userId: req.dbUserId! },
      include: { transfers: { orderBy: { date: 'desc' } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(projects.map(({ transfers, ...p }) => ({ ...p, transferCount: transfers.length, totals: totals({ ...p, transfers }) })));
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = ProjectFields.parse(req.body);
    res.status(201).json(await db.developmentProject.create({ data: { ...(data as any), userId: req.dbUserId! } }));
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const project = await db.developmentProject.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
      include: { transfers: { orderBy: { date: 'desc' } } },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const banks = await db.bankAccount.findMany({ where: { userId: req.dbUserId! }, select: { id: true, name: true, last4: true } });
    const bankName = new Map(banks.map(b => [b.id, b.last4 ? `${b.name} ••${b.last4}` : b.name]));
    res.json({
      ...project,
      transfers: project.transfers.map(t => ({ ...t, amountLocalComputed: localOf(t), bankAccountName: t.bankAccountId ? bankName.get(t.bankAccountId) ?? null : null, hasDocument: !!t.documentS3Key, documentS3Key: undefined })),
      totals: totals(project),
    });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    if (!(await ownedProject(req.params.id, req.dbUserId!))) return res.status(404).json({ error: 'Project not found' });
    const data = ProjectFields.partial().parse(req.body);
    res.json(await db.developmentProject.update({ where: { id: req.params.id }, data: data as any }));
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!(await ownedProject(req.params.id, req.dbUserId!))) return res.status(404).json({ error: 'Project not found' });
    await db.developmentProject.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /read-receipt — the fields of a transfer receipt; saves nothing.
router.post('/read-receipt', async (req, res, next) => {
  try {
    const { files } = z.object({ files: z.array(File).min(1).max(6) }).parse(req.body);
    res.json(await readDocument('transfer_receipt', files, req.dbUserId!));
  } catch (err: any) {
    if (err?.message) return res.status(422).json({ error: err.message });
    next(err);
  }
});

router.post('/:id/transfers', async (req, res, next) => {
  try {
    const project = await ownedProject(req.params.id, req.dbUserId!);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { file, ...data } = TransferFields.parse(req.body);
    await checkBank(data.bankAccountId, req.dbUserId!);
    let documentS3Key: string | undefined;
    if (file) {
      documentS3Key = `${req.dbUserId}/projects/${project.id}/${Date.now()}_${sanitize(file.name)}`;
      await uploadDocument(documentS3Key, Buffer.from(file.data, 'base64'));
    }
    res.status(201).json(await db.projectTransfer.create({ data: { ...(data as any), projectId: project.id, documentS3Key } }));
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.patch('/transfers/:tid', async (req, res, next) => {
  try {
    const existing = await ownedTransfer(req.params.tid, req.dbUserId!);
    if (!existing) return res.status(404).json({ error: 'Transfer not found' });
    const { file, ...data } = TransferFields.partial().parse(req.body);
    await checkBank(data.bankAccountId, req.dbUserId!);
    let documentS3Key: string | undefined;
    if (file) {
      documentS3Key = `${req.dbUserId}/projects/${existing.projectId}/${Date.now()}_${sanitize(file.name)}`;
      await uploadDocument(documentS3Key, Buffer.from(file.data, 'base64'));
    }
    res.json(await db.projectTransfer.update({ where: { id: existing.id }, data: { ...(data as any), ...(documentS3Key ? { documentS3Key } : {}) } }));
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/transfers/:tid', async (req, res, next) => {
  try {
    const existing = await ownedTransfer(req.params.tid, req.dbUserId!);
    if (!existing) return res.status(404).json({ error: 'Transfer not found' });
    await db.projectTransfer.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

router.get('/transfers/:tid/document', async (req, res, next) => {
  try {
    const existing = await ownedTransfer(req.params.tid, req.dbUserId!);
    if (!existing?.documentS3Key) return res.status(404).json({ error: 'No receipt attached' });
    res.json({ url: await getSignedDocumentUrl(existing.documentS3Key) });
  } catch (err) { next(err); }
});

export default router;
