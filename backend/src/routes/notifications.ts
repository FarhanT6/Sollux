import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
const router = Router();
router.use(attachDbUser);
router.get('/preferences', async (req, res, next) => {
  try {
    const prefs = await db.notificationPreference.findMany({ where: { userId: req.dbUserId! } });
    res.json(prefs);
  } catch (err) { next(err); }
});
router.patch('/preferences', async (req, res, next) => {
  try {
    const { channel, eventType, isEnabled, thresholdDays } = req.body;
    const pref = await db.notificationPreference.upsert({
      where: { userId_channel_eventType: { userId: req.dbUserId!, channel, eventType } },
      create: { userId: req.dbUserId!, channel, eventType, isEnabled, thresholdDays: thresholdDays || 5 },
      update: { isEnabled, thresholdDays },
    });
    res.json(pref);
  } catch (err) { next(err); }
});
export default router;
