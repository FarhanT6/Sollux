/**
 * People in the owner's household (Personal → people): a parent's or a
 * sibling's cards, loans, expenses and bills are tracked under their name,
 * each with an overview of their own, and all of them together under
 * Everyone. The owner is not a row: anything with no member is theirs.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

// GET /api/household — the people, each with how much is linked to them.
router.get('/', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;
    const members = await db.householdMember.findMany({ where: { userId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    const count = async (memberId: string | null) => ({
      cards: await db.creditCard.count({ where: { userId, memberId } }),
      loans: await db.loan.count({ where: { userId, isPersonal: true, memberId } }),
      bills: await db.utilityAccount.count({ where: { property: { userId }, isPersonal: true, memberId } }),
    });
    // Who is looking: the owner, or someone signed in with their own login on the account
    // (shared family access), matched to their person by the login linked to it, else by name.
    const owner = await db.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    const actingId = req.actingUserId ?? userId;
    const logins = await db.user.findMany({ where: { ownerUserId: userId }, select: { id: true, fullName: true, email: true } });
    let viewerMemberId: string | null = null;
    if (actingId !== userId) {
      const me = await db.user.findUnique({ where: { id: actingId }, select: { fullName: true } });
      const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
      const linked = members.find(m => m.loginUserId === actingId) ?? members.find(m => !m.loginUserId && norm(m.name) === norm(me?.fullName));
      viewerMemberId = linked?.id ?? null;
    }
    res.json({
      members: await Promise.all(members.map(async m => ({ ...m, linked: await count(m.id) }))), me: await count(null),
      ownerName: owner?.fullName ?? 'Owner', viewerMemberId, viewerIsOwner: actingId === userId,
      logins: req.isAccountOwner ? logins : [],
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    const n = await db.householdMember.count({ where: { userId: req.dbUserId! } });
    res.status(201).json(await db.householdMember.create({ data: { userId: req.dbUserId!, name, sortOrder: n } }));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Give the person a name.' });
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { name, loginUserId } = z.object({ name: z.string().trim().min(1).max(60).optional(), loginUserId: z.string().nullable().optional() }).parse(req.body);
    const m = await db.householdMember.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!m) return res.status(404).json({ error: 'Not found' });
    // A login can be linked only to someone with shared access to this account, and only by the owner.
    if (loginUserId !== undefined) {
      if (!req.isAccountOwner) return res.status(403).json({ error: 'Only the account owner links logins.' });
      if (loginUserId && !(await db.user.findFirst({ where: { id: loginUserId, ownerUserId: req.dbUserId! }, select: { id: true } }))) return res.status(404).json({ error: 'Login not found' });
      if (loginUserId) await db.householdMember.updateMany({ where: { userId: req.dbUserId!, loginUserId, id: { not: m.id } }, data: { loginUserId: null } });
    }
    res.json(await db.householdMember.update({ where: { id: m.id }, data: { ...(name ? { name } : {}), ...(loginUserId !== undefined ? { loginUserId } : {}) } }));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Give the person a name.' });
    next(err);
  }
});

// DELETE — the person goes; what was theirs goes back to the owner, nothing is deleted.
router.delete('/:id', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;
    const m = await db.householdMember.findFirst({ where: { id: req.params.id, userId } });
    if (!m) return res.status(404).json({ error: 'Not found' });
    await db.$transaction([
      db.creditCard.updateMany({ where: { userId, memberId: m.id }, data: { memberId: null } }),
      db.loan.updateMany({ where: { userId, memberId: m.id }, data: { memberId: null } }),
      db.expense.updateMany({ where: { userId, memberId: m.id }, data: { memberId: null } }),
      db.utilityAccount.updateMany({ where: { property: { userId }, memberId: m.id }, data: { memberId: null } }),
      db.householdMember.delete({ where: { id: m.id } }),
    ]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/household/assign { kind, id, memberId } — whose a card, loan, expense or personal bill is (null: the owner's).
router.post('/assign', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;
    const { kind, id, memberId } = z.object({ kind: z.enum(['card', 'loan', 'expense', 'bill']), id: z.string(), memberId: z.string().nullable() }).parse(req.body);
    if (memberId && !(await db.householdMember.findFirst({ where: { id: memberId, userId }, select: { id: true } }))) return res.status(404).json({ error: 'Person not found' });
    const r = kind === 'card' ? await db.creditCard.updateMany({ where: { id, userId }, data: { memberId } })
      : kind === 'loan' ? await db.loan.updateMany({ where: { id, userId }, data: { memberId } })
      : kind === 'expense' ? await db.expense.updateMany({ where: { id, userId }, data: { memberId } })
      : await db.utilityAccount.updateMany({ where: { id, property: { userId } }, data: { memberId } });
    if (!r.count) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Choose what to assign.' });
    next(err);
  }
});

export default router;

/** Whether a member id is the owner's own household member (null/undefined: nothing to check). */
export async function memberOk(userId: string, memberId: string | null | undefined): Promise<boolean> {
  return !memberId || !!(await db.householdMember.findFirst({ where: { id: memberId, userId }, select: { id: true } }));
}

/** A `member` query value as a filter: 'me' is the owner's own (no member), an id is that person's, nothing is everyone. */
export function memberFilter(v: unknown): { memberId?: string | null } {
  if (typeof v !== 'string' || !v || v === 'all') return {};
  return { memberId: v === 'me' ? null : v };
}
