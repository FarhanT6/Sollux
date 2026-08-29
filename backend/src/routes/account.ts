import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

function normalizePhone(p?: string | null): string | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits || null;
}

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
      db.user.findUnique({ where: { id: req.actingUserId! }, select: { id: true, email: true, fullName: true } }),
    ]);
    res.json({ owner, members, pendingInvites: invites, me, isOwner: !!req.isAccountOwner });
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
