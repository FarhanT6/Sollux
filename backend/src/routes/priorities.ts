import { Router } from 'express';
import { attachDbUser } from '../middleware/requireAuth';
import { getPaymentPriorities, getFeeSummary } from '../services/paymentPriority';

/**
 * What to pay first, and what late payment has cost.
 *
 * Deliberately separate from the utility routes: those report what a property
 * costs to run, these report what is owed and what delay would cost. Mixing
 * the two is what made the old monthly total meaningless.
 */
const router = Router();
router.use(attachDbUser);

// GET /api/priorities?propertyId=...
router.get('/', async (req, res, next) => {
  try {
    const propertyId = req.query.propertyId ? String(req.query.propertyId) : undefined;
    res.json(await getPaymentPriorities(req.dbUserId!, propertyId));
  } catch (err) { next(err); }
});

// GET /api/priorities/fees?months=12
router.get('/fees', async (req, res, next) => {
  try {
    const months = req.query.months ? Number(req.query.months) : null;
    let since: Date | undefined;
    if (months && months > 0) {
      since = new Date();
      since.setMonth(since.getMonth() - months);
    }
    res.json(await getFeeSummary(req.dbUserId!, since));
  } catch (err) { next(err); }
});

export default router;
