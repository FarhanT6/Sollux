/**
 * Shut-off, past-due and cancellation notices (services/noticeTracker.ts).
 *
 * GET  /api/service-notices?status=OPEN|RESOLVED|ALL   — newest cut-off first
 * POST /api/service-notices/:id/resolve { reason? }    — the owner says it is handled
 * POST /api/service-notices/:id/reopen
 * PATCH /api/service-notices/:id { utilityAccountId }  — match an unmatched notice to its account
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { clearNoticeAlert, resolveIfPaid } from '../services/noticeTracker';

const router = Router();
router.use(attachDbUser);

router.get('/', async (req, res, next) => {
  try {
    const status = String(req.query.status ?? 'OPEN').toUpperCase();
    const notices = await db.serviceNotice.findMany({
      where: { userId: req.dbUserId!, ...(status === 'ALL' ? {} : { status }) },
      orderBy: [{ cutoffDate: 'asc' }, { noticeDate: 'desc' }],
      take: 200,
    });
    const ids = [...new Set(notices.map(n => n.utilityAccountId).filter((x): x is string => !!x))];
    const accounts = await db.utilityAccount.findMany({
      where: { id: { in: ids }, property: { userId: req.dbUserId! } },
      select: { id: true, providerName: true, propertyId: true, property: { select: { address: true, nickname: true } } },
    });
    const byId = new Map(accounts.map(a => [a.id, a]));
    res.json(notices.map(n => {
      const a = n.utilityAccountId ? byId.get(n.utilityAccountId) : null;
      return {
        id: n.id, kind: n.kind, status: n.status, provider: a?.providerName ?? n.provider, accountLast4: n.accountLast4,
        utilityAccountId: a ? n.utilityAccountId : null, propertyId: a?.propertyId ?? null, property: a ? (a.property.nickname || a.property.address) : null,
        noticeDate: n.noticeDate, cutoffDate: n.cutoffDate, amountDemanded: n.amountDemanded == null ? null : Number(n.amountDemanded),
        summary: n.summary, resolvedAt: n.resolvedAt, resolvedReason: n.resolvedReason,
      };
    }));
  } catch (err) { next(err); }
});

async function owned(id: string, userId: string) {
  return db.serviceNotice.findFirst({ where: { id, userId } });
}

router.post('/:id/resolve', async (req, res, next) => {
  try {
    const n = await owned(req.params.id, req.dbUserId!);
    if (!n) return res.status(404).json({ error: 'Not found' });
    const { reason } = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});
    await db.serviceNotice.update({ where: { id: n.id }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedReason: reason || 'Marked resolved' } });
    await clearNoticeAlert(n.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/reopen', async (req, res, next) => {
  try {
    const n = await owned(req.params.id, req.dbUserId!);
    if (!n) return res.status(404).json({ error: 'Not found' });
    await db.serviceNotice.update({ where: { id: n.id }, data: { status: 'OPEN', resolvedAt: null, resolvedReason: null } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const n = await owned(req.params.id, req.dbUserId!);
    if (!n) return res.status(404).json({ error: 'Not found' });
    const { utilityAccountId } = z.object({ utilityAccountId: z.string() }).parse(req.body);
    const acct = await db.utilityAccount.findFirst({ where: { id: utilityAccountId, property: { userId: req.dbUserId! } }, select: { id: true } });
    if (!acct) return res.status(404).json({ error: 'Account not found' });
    await db.serviceNotice.update({ where: { id: n.id }, data: { utilityAccountId } });
    await resolveIfPaid(n.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
