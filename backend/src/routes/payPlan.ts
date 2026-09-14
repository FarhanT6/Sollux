import { Router } from 'express';
import { attachDbUser } from '../middleware/requireAuth';
import { buildPayPlan } from '../lib/payPlan';

const router = Router();
router.use(attachDbUser);

// GET /api/pay-plan?days=14&cushion=500&utilities=1
router.get('/', async (req, res, next) => {
  try {
    const days = req.query.days != null ? Number(req.query.days) : undefined;
    const cushion = req.query.cushion != null ? Number(req.query.cushion) : undefined;
    const utilities = req.query.utilities == null ? true : req.query.utilities !== '0';
    const plan = await buildPayPlan(req.dbUserId!, {
      horizonDays: Number.isFinite(days) ? days : undefined,
      cushion: Number.isFinite(cushion) ? cushion : undefined,
      includeUtilities: utilities,
    });
    res.json(plan);
  } catch (err) { next(err); }
});

export default router;
