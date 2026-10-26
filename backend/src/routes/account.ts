import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { MODULES, modulesOf } from '../lib/modules';

const router = Router();
router.use(attachDbUser);

function normalizePhone(p?: string | null): string | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits || null;
}

// The optional modules this account uses (lib/modules.ts). Members see the owner's.
router.get('/modules', async (req, res, next) => {
  try {
    const u = await db.user.findUnique({ where: { id: req.dbUserId! }, select: { modulesJson: true } });
    res.json({ modules: modulesOf(u ?? {}), isAdmin: !!req.isPlatformAdmin, isOwner: !!req.isAccountOwner });
  } catch (err) { next(err); }
});
router.put('/modules', async (req, res, next) => {
  try {
    if (!req.isAccountOwner) return res.status(403).json({ error: 'Only the account owner can change which modules are on.' });
    const { modules } = z.object({ modules: z.array(z.enum(MODULES)) }).parse(req.body);
    await db.user.update({ where: { id: req.dbUserId! }, data: { modulesJson: [...new Set(modules)] } });
    res.json({ modules: [...new Set(modules)] });
  } catch (err) { next(err); }
});

// Who rent is payable to on this account's 3-day notices.
const PayableTo = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).default(''),
  email: z.string().trim().max(120).default(''),
  address: z.string().trim().min(1).max(240),
});
router.get('/payable-to', async (req, res, next) => {
  try {
    const u = await db.user.findUnique({ where: { id: req.dbUserId! }, select: { rentPayableToJson: true } });
    res.json({ payableTo: u?.rentPayableToJson ?? null });
  } catch (err) { next(err); }
});
router.put('/payable-to', async (req, res, next) => {
  try {
    const payableTo = PayableTo.parse(req.body);
    await db.user.update({ where: { id: req.dbUserId! }, data: { rentPayableToJson: payableTo } });
    res.json({ payableTo });
  } catch (err) { next(err); }
});

// GET /api/account — who am I, and who shares this account?
router.get('/', async (req, res, next) => {
  try {
    const ownerId = req.dbUserId!;
    const [owner, members, invites, me] = await Promise.all([
      db.user.findUnique({ where: { id: ownerId }, select: { id: true, email: true, fullName: true, phone: true } }),
      db.user.findMany({
        where: { ownerUserId: ownerId },
        select: { id: true, email: true, fullName: true, phone: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.accountInvite.findMany({
        where: { ownerUserId: ownerId, acceptedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      db.user.findUnique({ where: { id: req.actingUserId! }, select: { id: true, email: true, fullName: true, phone: true } }),
    ]);
    res.json({ owner, members, pendingInvites: invites, me, isOwner: !!req.isAccountOwner });
  } catch (err) { next(err); }
});

// PATCH /api/account/phone — the mobile number shut-off and cancellation
// alerts are texted to. Each person sets their own.
router.patch('/phone', async (req, res, next) => {
  try {
    const { phone } = z.object({ phone: z.string().max(30).nullable() }).parse(req.body);
    let e164: string | null = null;
    if (phone && phone.trim()) {
      const digits = phone.replace(/\D/g, '');
      if (digits.length === 10) e164 = `+1${digits}`;
      else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
      else if (phone.trim().startsWith('+') && digits.length >= 8 && digits.length <= 15) e164 = `+${digits}`;
      else return res.status(400).json({ error: 'Enter a mobile number like (760) 555-0123.' });
    }
    await db.user.update({ where: { id: req.actingUserId! }, data: { phone: e164 } });
    res.json({ phone: e164 });
  } catch (err) { next(err); }
});

const InviteSchema = z.object({
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
}).refine(d => d.email || d.phone, { message: 'An email or phone number is required' });

// POST /api/account/invites — invite someone to share this account.
// Owner-only: a member cannot add further members.
router.post('/invites', async (req, res, next) => {
  try {
    if (!req.isAccountOwner) return res.status(403).json({ error: 'Only the account owner can add members' });
    const data = InviteSchema.parse(req.body);
    const ownerId = req.dbUserId!;
    const email = data.email?.trim().toLowerCase() || null;
    const phone = normalizePhone(data.phone);

    if (email) {
      const owner = await db.user.findUnique({ where: { id: ownerId }, select: { email: true } });
      if (owner?.email.toLowerCase() === email) {
        return res.status(400).json({ error: 'That is already the owner account' });
      }
    }

    // If they already have a Sollux login, link immediately.
    const existing = email
      ? await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
      : null;

    if (existing) {
      if (existing.id === ownerId) return res.status(400).json({ error: 'That is already the owner account' });
      if (existing.ownerUserId && existing.ownerUserId !== ownerId) {
        return res.status(400).json({ error: 'That person already shares a different account' });
      }
      if (await db.user.count({ where: { ownerUserId: existing.id } })) {
        return res.status(400).json({ error: 'That person owns an account with its own members' });
      }
      const linked = await db.user.update({
        where: { id: existing.id },
        data: { ownerUserId: ownerId },
        select: { id: true, email: true, fullName: true, phone: true, createdAt: true },
      });
      return res.status(201).json({ linked: true, member: linked });
    }

    const invite = await db.accountInvite.create({
      data: { ownerUserId: ownerId, email, phone },
    });
    res.status(201).json({ linked: false, invite });
  } catch (err) { next(err); }
});

// DELETE /api/account/invites/:id — cancel a pending invite
router.delete('/invites/:id', async (req, res, next) => {
  try {
    if (!req.isAccountOwner) return res.status(403).json({ error: 'Only the account owner can manage members' });
    await db.accountInvite.deleteMany({ where: { id: req.params.id, ownerUserId: req.dbUserId! } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// DELETE /api/account/members/:id — revoke a member's shared access.
// Their login and their own (empty) account remain; they just lose access.
router.delete('/members/:id', async (req, res, next) => {
  try {
    if (!req.isAccountOwner) return res.status(403).json({ error: 'Only the account owner can manage members' });
    const member = await db.user.findFirst({ where: { id: req.params.id, ownerUserId: req.dbUserId! } });
    if (!member) return res.status(404).json({ error: 'Member not found' });
    await db.user.update({ where: { id: member.id }, data: { ownerUserId: null } });
    // Drop any accepted invite so they aren't auto-relinked on next sign-in.
    await db.accountInvite.deleteMany({ where: { ownerUserId: req.dbUserId!, acceptedByUserId: member.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
