import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { draftRentReminders } from '../ai/rentCollections';

// Messages Sollux drafted for the owner to send (rent reminders). The owner
// sends them from their own email or phone and marks them sent here.
const router = Router();
router.use(attachDbUser);

router.get('/', async (req, res, next) => {
  try {
    const drafts = await db.messageDraft.findMany({
      where: { userId: req.dbUserId!, status: (req.query.status as string) || 'DRAFT' },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    res.json(drafts.map(d => ({ ...d, amountDue: d.amountDue != null ? Number(d.amountDue) : null })));
  } catch (err) { next(err); }
});

// POST /draft-now — run the assistant now instead of waiting for tonight.
router.post('/draft-now', async (req, res, next) => {
  try { res.json(await draftRentReminders(req.dbUserId!)); } catch (err) { next(err); }
});

router.post('/:id/:action(sent|dismiss)', async (req, res, next) => {
  try {
    const d = await db.messageDraft.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!d) return res.status(404).json({ error: 'Not found' });
    const sent = req.params.action === 'sent';
    await db.messageDraft.update({ where: { id: d.id }, data: { status: sent ? 'SENT' : 'DISMISSED', sentAt: sent ? new Date() : null } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
