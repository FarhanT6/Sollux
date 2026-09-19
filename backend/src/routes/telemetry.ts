import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

/**
 * The app reporting its own crashes. A browser error or unhandled promise
 * rejection lands here so the nightly auditor can see what broke without
 * anyone having to describe it. Nothing sensitive is stored: the message,
 * the stack, the page and the browser.
 */
const router = Router();
router.use(attachDbUser);

const ErrorSchema = z.object({
  message: z.string().min(1).max(1000),
  stack: z.string().max(8000).optional().nullable(),
  url: z.string().max(500).optional().nullable(),
  userAgent: z.string().max(300).optional().nullable(),
});

router.post('/error', async (req, res, next) => {
  try {
    const data = ErrorSchema.parse(req.body);
    // The same crash repeating in one minute is one crash.
    const recent = await db.clientError.findFirst({
      where: { userId: req.dbUserId ?? null, message: data.message, createdAt: { gte: new Date(Date.now() - 60_000) } },
      select: { id: true },
    });
    if (!recent) {
      await db.clientError.create({ data: { ...data, userId: req.dbUserId ?? null } });
    }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
