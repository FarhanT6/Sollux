import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { getCashflow } from '../lib/cashflow';

const router = Router();
router.use(attachDbUser);

// GET /api/cashflow?year=&propertyId=
router.get('/', async (req, res, next) => {
  try {
    const year = req.query.year ? Number(req.query.year) : new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ error: 'Invalid year' });
    const propertyId = req.query.propertyId ? String(req.query.propertyId) : undefined;
    if (propertyId) {
      const prop = await db.property.findFirst({ where: { id: propertyId, userId: req.dbUserId! }, select: { id: true } });
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }
    res.json(await getCashflow(year, req.dbUserId!, propertyId));
  } catch (err) { next(err); }
});

export default router;
