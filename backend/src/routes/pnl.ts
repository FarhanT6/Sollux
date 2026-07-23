import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { getPropertyPnL, getPortfolioPnL, getMonthlyPnL } from '../lib/pnl';

const router = Router();
router.use(attachDbUser);

// GET /api/pnl/portfolio?start=&end=
router.get('/portfolio', async (req, res, next) => {
  try {
    const start = req.query.start ? new Date(req.query.start as string) : new Date(new Date().getFullYear(), 0, 1);
    const end = req.query.end ? new Date(req.query.end as string) : new Date(new Date().getFullYear() + 1, 0, 1);
    const result = await getPortfolioPnL({ start, end }, req.dbUserId!);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/pnl/property/:id?start=&end=
router.get('/property/:id', async (req, res, next) => {
  try {
    const start = req.query.start ? new Date(req.query.start as string) : new Date(new Date().getFullYear(), 0, 1);
    const end = req.query.end ? new Date(req.query.end as string) : new Date(new Date().getFullYear() + 1, 0, 1);
    const result = await getPropertyPnL(req.params.id, { start, end }, req.dbUserId!);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/pnl/monthly?year=&propertyId=
router.get('/monthly', async (req, res, next) => {
  try {
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    const propertyId = req.query.propertyId as string | undefined;
    if (propertyId) {
      const prop = await db.property.findFirst({ where: { id: propertyId, userId: req.dbUserId! } });
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }
    const result = await getMonthlyPnL(year, req.dbUserId!, propertyId);
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
