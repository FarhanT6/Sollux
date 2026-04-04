import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

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
      take: 50,
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
