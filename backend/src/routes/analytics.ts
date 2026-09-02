import { Router } from 'express';
import { attachDbUser } from '../middleware/requireAuth';
import { getChargeAnalytics, reconcileAging } from '../services/chargeAnalytics';

/**
 * What the money went on, line by line, and whether the provider's view of
 * arrears agrees with the statements on file.
 */
const router = Router();
router.use(attachDbUser);

// GET /api/analytics/charges/:accountId?months=24
router.get('/charges/:accountId', async (req, res, next) => {
  try {
    const months = req.query.months ? Number(req.query.months) : 24;
    const result = await getChargeAnalytics(req.params.accountId, req.dbUserId!, months);
    if (!result) return res.status(404).json({ error: 'Account not found' });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/analytics/aging/:accountId
router.get('/aging/:accountId', async (req, res, next) => {
  try {
    const result = await reconcileAging(req.params.accountId, req.dbUserId!);
    if (!result) return res.status(404).json({ error: 'Account not found' });
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
