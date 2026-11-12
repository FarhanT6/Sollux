/**
 * Bank deposits of several checks, read from the bank's deposit details page
 * (services/bankDeposit.ts): read → review → record, and undo.
 */
import { Router } from 'express';
import { z } from 'zod';
import { attachDbUser } from '../middleware/requireAuth';
import { detectContentType } from '../services/s3Service';
import { readDepositPages, draftDeposit, recordDeposit, undoDeposit } from '../services/bankDeposit';

const router = Router();
router.use(attachDbUser);

// POST /api/deposits/read { files: [{ fileData (base64), filename }] } — the deposit read and matched; nothing saved.
router.post('/read', async (req, res, next) => {
  try {
    const { files } = z.object({ files: z.array(z.object({ fileData: z.string().min(1), filename: z.string().max(200).default('deposit.png') })).min(1).max(10) }).parse(req.body);
    const bufs = files.map(f => ({ buf: Buffer.from(f.fileData, 'base64'), name: f.filename }));
    if (bufs.reduce((s, f) => s + f.buf.length, 0) > 20 * 1024 * 1024) return res.status(400).json({ error: 'Those files are over 20 MB together — send fewer or smaller screenshots.' });
    for (const f of bufs) {
      if (!/^(application\/pdf|image\/)/.test(detectContentType(f.buf, f.name))) return res.status(400).json({ error: `${f.name}: send screenshots or a PDF of the deposit details.` });
    }
    const read = await readDepositPages(bufs);
    if (!read.checks.length) return res.status(422).json({ error: 'No checks could be read from those pages. Open each check on the bank\'s page so its amount shows, and try again.' });
    res.json(await draftDeposit(req.dbUserId!, read));
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

const RecordSchema = z.object({
  bankAccountId: z.string().min(1), postDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), total: z.number(),
  checks: z.array(z.object({
    leaseId: z.string().min(1), amount: z.number().positive(), month: z.string(), rent: z.number(), utilities: z.number(),
    payer: z.string().nullable().optional(), checkNumber: z.string().nullable().optional(), memo: z.string().nullable().optional(),
  })).min(1).max(60),
});

// POST /api/deposits/record — the checks the owner kept, as rent and utility payments.
router.post('/record', async (req, res, next) => {
  try {
    res.json(await recordDeposit(req.dbUserId!, RecordSchema.parse(req.body)));
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/deposits/undo { key } — a recorded deposit's payments removed.
router.post('/undo', async (req, res, next) => {
  try {
    const { key } = z.object({ key: z.string().min(1) }).parse(req.body);
    res.json({ removed: await undoDeposit(req.dbUserId!, key) });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

export default router;
