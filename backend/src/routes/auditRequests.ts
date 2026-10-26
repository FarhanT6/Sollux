/**
 * Free portfolio audit requests. The landing page's form posts here without
 * signing in — the one public route besides auth and Stripe's webhook — so
 * it is rate-limited per address, takes at most 5 files of 10 MB (PDF or
 * image), and quietly drops anything that fills the hidden "website" field
 * (bots do). Files go to S3; the admin opens them with signed URLs.
 *
 *   POST /api/public/audit-requests          the form (public)
 *   GET  /api/admin/audit-requests           the list (admin only)
 *   PATCH /api/admin/audit-requests/:id      { status }
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument, getSignedDocumentUrl, detectContentType } from '../services/s3Service';
import { emailConfigured, sendAlertEmail } from '../services/notificationService';
import { isPlatformAdmin } from '../lib/plans';

const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const OK_TYPES = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/;

const Form = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).optional().nullable(),
  properties: z.coerce.number().int().min(0).max(100000).optional().nullable(),
  currentTools: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  website: z.string().optional().nullable(), // the hidden field: people leave it empty
  files: z.array(z.object({ name: z.string().max(200), dataBase64: z.string() })).max(MAX_FILES).optional(),
});

export const publicAuditRouter = Router();
publicAuditRouter.use(rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false }));

publicAuditRouter.post('/', async (req, res, next) => {
  try {
    const parsed = Form.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Please give your name and a valid email address.' });
    const f = parsed.data;
    if (f.website) return res.status(201).json({ ok: true }); // a bot
    const files = (f.files ?? []).map(x => ({ name: x.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'bill', buf: Buffer.from(x.dataBase64, 'base64') }));
    for (const x of files) {
      if (x.buf.length > MAX_BYTES) return res.status(400).json({ error: `${x.name} is over 10 MB.` });
      if (!OK_TYPES.test(detectContentType(x.buf, x.name))) return res.status(400).json({ error: `${x.name} is not a PDF or photo.` });
    }
    const row = await db.auditRequest.create({
      data: { name: f.name, email: f.email.toLowerCase(), phone: f.phone || null, properties: f.properties ?? null, currentTools: f.currentTools || null, notes: f.notes || null },
    });
    const keys: string[] = [];
    for (const [i, x] of files.entries()) {
      const key = `audit-requests/${row.id}/${i + 1}-${x.name}`;
      await uploadDocument(key, x.buf);
      keys.push(key);
    }
    if (keys.length) await db.auditRequest.update({ where: { id: row.id }, data: { fileKeysJson: keys } });

    // Tell the admin(s), when email is set up. The request is saved either way.
    if (emailConfigured()) {
      const owners = await db.user.findMany({ where: { ownerUserId: null }, select: { email: true, subscriptionTier: true } });
      for (const a of owners.filter(isPlatformAdmin)) {
        await sendAlertEmail({
          to: a.email, subject: `Portfolio audit request from ${f.name}`, headline: 'New portfolio audit request',
          lines: [`${f.name} · ${f.email}${f.phone ? ` · ${f.phone}` : ''}`, `${f.properties ?? '?'} properties${f.currentTools ? ` · uses ${f.currentTools}` : ''}`, `${keys.length} bill${keys.length === 1 ? '' : 's'} attached`, ...(f.notes ? [f.notes.slice(0, 300)] : [])],
          path: '/settings?tab=audits',
        }).catch(err => console.warn('[AuditRequest] email failed:', err instanceof Error ? err.message : err));
      }
    }
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

export const adminAuditRouter = Router();
adminAuditRouter.use(attachDbUser);
adminAuditRouter.use((req, res, next) => (req.isPlatformAdmin ? next() : res.status(403).json({ error: 'Admin only.' })));

adminAuditRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await db.auditRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    res.json(await Promise.all(rows.map(async r => ({
      ...r,
      fileKeysJson: undefined,
      files: await Promise.all(((r.fileKeysJson as string[] | null) ?? []).map(async key => ({ name: key.split('/').pop()!.replace(/^\d+-/, ''), url: await getSignedDocumentUrl(key) }))),
    }))));
  } catch (err) { next(err); }
});

adminAuditRouter.patch('/:id', async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(['new', 'contacted', 'audited', 'converted', 'declined']) }).parse(req.body);
    const r = await db.auditRequest.update({ where: { id: req.params.id }, data: { status } }).catch(() => null);
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json({ id: r.id, status: r.status });
  } catch (err) { next(err); }
});
