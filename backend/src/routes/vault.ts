/**
 * The vault: bank accounts, cards, logins, ID numbers.
 *
 * Zero-knowledge by design. The browser encrypts every record with a random
 * data key; the data key is wrapped by a key derived from the owner's vault
 * passphrase (PBKDF2-SHA256) and, separately, by a one-time recovery key.
 * This server only ever receives ciphertext — never the passphrase, the
 * recovery key, the data key or a plaintext field — and encrypts what it
 * stores once more with ENCRYPTION_KEY, so a copy of the database alone
 * opens nothing.
 *
 * On top of that: responses are never cached, vault calls have their own
 * rate limit, five wrong passphrases in 15 minutes lock the wrapped key
 * away for 15 minutes, and every unlock, reveal, copy and change is logged.
 * Nothing in the AI features, agents or exports reads these tables.
 */
import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { encrypt, decrypt } from '../crypto/encrypt';

const router = Router();
router.use(attachDbUser);
router.use(rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
});

const KINDS = ['BANK_ACCOUNT', 'CARD', 'LOGIN', 'ID_DOCUMENT', 'NOTE'] as const;
const B64 = /^[A-Za-z0-9+/=]+$/;
// "iv:ciphertext", both base64 — the only shape the browser sends.
const Sealed = z.string().max(40000).refine(v => { const [iv, ct, ...rest] = v.split(':'); return !rest.length && !!iv && !!ct && B64.test(iv) && B64.test(ct); }, 'not a sealed value');
const LOCKOUT_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

async function log(req: Request, action: string, itemId?: string | null) {
  await db.vaultAccessLog.create({
    data: { userId: req.dbUserId!, action, itemId: itemId ?? null, ip: (req.ip ?? '').slice(0, 64) || null, userAgent: (req.get('user-agent') ?? '').slice(0, 200) || null },
  }).catch(() => {});
}

async function lockedUntil(userId: string): Promise<Date | null> {
  const since = new Date(Date.now() - LOCKOUT_MS);
  const lastGood = await db.vaultAccessLog.findFirst({ where: { userId, action: { in: ['UNLOCK', 'RECOVERED'] } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const fails = await db.vaultAccessLog.findMany({
    where: { userId, action: 'UNLOCK_FAILED', createdAt: { gte: lastGood && lastGood.createdAt > since ? lastGood.createdAt : since } },
    orderBy: { createdAt: 'desc' }, take: LOCKOUT_FAILS, select: { createdAt: true },
  });
  if (fails.length < LOCKOUT_FAILS) return null;
  const until = new Date(fails[0]!.createdAt.getTime() + LOCKOUT_MS);
  return until > new Date() ? until : null;
}

// GET /api/vault/key — the wrapped data key and KDF parameters (or that the
// vault is not set up). Withheld while locked out.
router.get('/key', async (req, res, next) => {
  try {
    const key = await db.vaultKey.findUnique({ where: { userId: req.dbUserId! } });
    if (!key) return res.json({ setUp: false });
    const until = await lockedUntil(req.dbUserId!);
    if (until) return res.status(423).json({ error: `Too many wrong passphrases. The vault is locked until ${until.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })} PT.`, lockedUntil: until });
    res.json({
      setUp: true, salt: key.salt, iterations: key.iterations, recoverySalt: key.recoverySalt,
      wrappedByPassphrase: decrypt(key.wrappedByPassphrase), wrappedByRecovery: decrypt(key.wrappedByRecovery),
    });
  } catch (err) { next(err); }
});

const KeySchema = z.object({
  salt: z.string().regex(B64).max(64), iterations: z.number().int().min(310000).max(5000000),
  wrappedByPassphrase: Sealed, wrappedByRecovery: Sealed, recoverySalt: z.string().regex(B64).max(64),
});

// POST /api/vault/setup — first time only.
router.post('/setup', async (req, res, next) => {
  try {
    const k = KeySchema.parse(req.body);
    if (await db.vaultKey.findUnique({ where: { userId: req.dbUserId! } })) return res.status(409).json({ error: 'The vault is already set up.' });
    await db.vaultKey.create({ data: { userId: req.dbUserId!, salt: k.salt, iterations: k.iterations, recoverySalt: k.recoverySalt, wrappedByPassphrase: encrypt(k.wrappedByPassphrase), wrappedByRecovery: encrypt(k.wrappedByRecovery) } });
    await log(req, 'SETUP');
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /api/vault/key — a new passphrase (the data key re-wrapped in the browser;
// the records are untouched). `recovered` when it was opened with the recovery key.
router.put('/key', async (req, res, next) => {
  try {
    const k = KeySchema.extend({ recovered: z.boolean().optional() }).parse(req.body);
    const existing = await db.vaultKey.findUnique({ where: { userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'The vault is not set up.' });
    await db.vaultKey.update({ where: { id: existing.id }, data: { salt: k.salt, iterations: k.iterations, recoverySalt: k.recoverySalt, wrappedByPassphrase: encrypt(k.wrappedByPassphrase), wrappedByRecovery: encrypt(k.wrappedByRecovery) } });
    await log(req, k.recovered ? 'RECOVERED' : 'PASSPHRASE_CHANGED');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/vault/items — every record, still sealed.
router.get('/items', async (req, res, next) => {
  try {
    const items = await db.vaultItem.findMany({ where: { userId: req.dbUserId! }, orderBy: { createdAt: 'asc' } });
    res.json(items.map(i => ({ id: i.id, kind: i.kind, payload: decrypt(i.payload), createdAt: i.createdAt, updatedAt: i.updatedAt })));
  } catch (err) { next(err); }
});

const ItemSchema = z.object({ kind: z.enum(KINDS), payload: Sealed });

router.post('/items', async (req, res, next) => {
  try {
    const { kind, payload } = ItemSchema.parse(req.body);
    if (!(await db.vaultKey.findUnique({ where: { userId: req.dbUserId! }, select: { id: true } }))) return res.status(409).json({ error: 'Set up the vault first.' });
    const count = await db.vaultItem.count({ where: { userId: req.dbUserId! } });
    if (count >= 500) return res.status(400).json({ error: 'The vault holds up to 500 records.' });
    const item = await db.vaultItem.create({ data: { userId: req.dbUserId!, kind, payload: encrypt(payload) } });
    await log(req, 'CREATE', item.id);
    res.status(201).json({ id: item.id, kind: item.kind, createdAt: item.createdAt, updatedAt: item.updatedAt });
  } catch (err) { next(err); }
});

router.put('/items/:id', async (req, res, next) => {
  try {
    const { kind, payload } = ItemSchema.parse(req.body);
    const item = await db.vaultItem.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!item) return res.status(404).json({ error: 'Not found' });
    const updated = await db.vaultItem.update({ where: { id: item.id }, data: { kind, payload: encrypt(payload) } });
    await log(req, 'UPDATE', item.id);
    res.json({ id: updated.id, kind: updated.kind, createdAt: updated.createdAt, updatedAt: updated.updatedAt });
  } catch (err) { next(err); }
});

router.delete('/items/:id', async (req, res, next) => {
  try {
    const item = await db.vaultItem.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!item) return res.status(404).json({ error: 'Not found' });
    await db.vaultItem.delete({ where: { id: item.id } });
    await log(req, 'DELETE', item.id);
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/vault/events — what happened in the browser: an unlock (or a
// wrong passphrase), a field revealed or copied.
router.post('/events', async (req, res, next) => {
  try {
    const { action, itemId } = z.object({ action: z.enum(['UNLOCK', 'UNLOCK_FAILED', 'REVEAL', 'COPY']), itemId: z.string().max(40).optional() }).parse(req.body);
    await log(req, action, itemId);
    const until = action === 'UNLOCK_FAILED' ? await lockedUntil(req.dbUserId!) : null;
    res.json({ lockedUntil: until });
  } catch (err) { next(err); }
});

// GET /api/vault/activity — the access log, newest first.
router.get('/activity', async (req, res, next) => {
  try {
    const rows = await db.vaultAccessLog.findMany({ where: { userId: req.dbUserId! }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(rows.map(r => ({ id: r.id, action: r.action, itemId: r.itemId, ip: r.ip, userAgent: r.userAgent, createdAt: r.createdAt })));
  } catch (err) { next(err); }
});

export default router;
