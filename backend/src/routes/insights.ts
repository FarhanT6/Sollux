import { Router } from 'express';
import { savingsReport } from '../services/savingsReport';
import { researchState, startSavingsResearch } from '../services/savingsResearch';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { runBookkeeperForUser } from '../ai/bookkeeper';

const router = Router();
router.use(attachDbUser);

// GET /api/insights
router.get('/', async (req, res, next) => {
  try {
    const { propertyId, severity, type, unread } = req.query;

    const userProperties = await db.property.findMany({
      where: { userId: req.dbUserId! },
      select: { id: true },
    });
    const propertyIds = userProperties.map(p => p.id);

    const where: any = {
      propertyId: propertyId ? String(propertyId) : { in: propertyIds },
      isDismissed: false,
    };
    if (severity) where.severity = String(severity).toUpperCase();
    if (type) where.insightType = String(type).toUpperCase();
    if (unread === 'true') where.isRead = false;

    const insights = await db.aIInsight.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 300,
      include: {
        property: { select: { address: true, nickname: true, city: true } },
        utilityAccount: { select: { providerName: true, category: true } },
      },
    });

    res.json(insights);
  } catch (err) {
    next(err);
  }
});

// POST /api/insights/bookkeeper/run — run the nightly bookkeeper now for
// this owner and return what it found.
// GET /api/insights/savings — where the owner can save, a dollar figure a year each (lib/savings.ts).
router.get('/savings', async (req, res, next) => {
  try {
    const [report, research] = await Promise.all([savingsReport(req.dbUserId!), researchState(req.dbUserId!)]);
    res.json({ ...report, research });
  } catch (err) { next(err); }
});

// POST /api/insights/savings/research — look into each company for promotions, waivers and cheaper service (services/savingsResearch.ts).
router.post('/savings/research', async (req, res, next) => {
  try {
    const started = await startSavingsResearch(req.dbUserId!);
    res.status(started ? 202 : 200).json({ started, research: await researchState(req.dbUserId!) });
  } catch (err: any) {
    if (err?.status || /budget|allowance/i.test(err?.message ?? '')) return res.status(err.status ?? 402).json({ error: err.message });
    next(err);
  }
});

router.post('/bookkeeper/run', async (req, res, next) => {
  try {
    const result = await runBookkeeperForUser(req.dbUserId!);
    res.json({ raised: result.raised, refreshed: result.refreshed, cleared: result.cleared, count: result.findings.length });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/insights/read-all — mark every unread, non-dismissed insight
// owned by this user as read.
router.patch('/read-all', async (req, res, next) => {
  try {
    const userProperties = await db.property.findMany({
      where: { userId: req.dbUserId! },
      select: { id: true },
    });
    const result = await db.aIInsight.updateMany({
      where: { propertyId: { in: userProperties.map(p => p.id) }, isDismissed: false, isRead: false },
      data: { isRead: true },
    });
    res.json({ count: result.count });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/insights/dismiss-info — dismiss every INFO-severity insight
// owned by this user.
router.patch('/dismiss-info', async (req, res, next) => {
  try {
    const userProperties = await db.property.findMany({
      where: { userId: req.dbUserId! },
      select: { id: true },
    });
    const result = await db.aIInsight.updateMany({
      where: { propertyId: { in: userProperties.map(p => p.id) }, isDismissed: false, severity: 'INFO' },
      data: { isDismissed: true },
    });
    res.json({ count: result.count });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/insights/:id/read
router.patch('/:id/read', async (req, res, next) => {
  try {
    const insight = await db.aIInsight.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
    });
    if (!insight) return res.status(404).json({ error: 'Insight not found' });

    const updated = await db.aIInsight.update({
      where: { id: req.params.id },
      data: { isRead: true },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/insights/:id/dismiss
router.patch('/:id/dismiss', async (req, res, next) => {
  try {
    const insight = await db.aIInsight.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
    });
    if (!insight) return res.status(404).json({ error: 'Insight not found' });

    const updated = await db.aIInsight.update({
      where: { id: req.params.id },
      data: { isDismissed: true },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
