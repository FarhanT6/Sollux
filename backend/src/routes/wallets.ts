/**
 * Cash and payment-app balances (services/wallets.ts): GET the wallets with their
 * balances and entries; set a wallet's opening balance or start date; record where
 * money went (to a bank, spent, to another wallet, a correction) or came from.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { walletReport, addMovement, updateMovement, deleteMovement, depositChecks, undoCheckDeposit, MOVEMENT_TYPES } from '../services/wallets';

const router = Router();
router.use(attachDbUser);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform(s => new Date(`${s}T00:00:00.000Z`));
const fail = (res: any, next: any) => (err: any) => (err?.status ? res.status(err.status).json({ error: err.message }) : next(err));

router.get('/', (req, res, next) => { walletReport(req.dbUserId!).then(r => res.json(r)).catch(fail(res, next)); });

router.patch('/:id', async (req, res, next) => {
  try {
    const d = z.object({ openingBalance: z.number().optional(), startedAt: day.optional() }).parse(req.body);
    const w = await db.wallet.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!w) return res.status(404).json({ error: 'Wallet not found' });
    await db.wallet.update({ where: { id: w.id }, data: d });
    res.json(await walletReport(req.dbUserId!));
  } catch (err) { fail(res, next)(err); }
});

router.post('/:id/movements', async (req, res, next) => {
  try {
    const d = z.object({
      date: day, amount: z.number().refine(n => n !== 0), type: z.enum(MOVEMENT_TYPES),
      bankAccountId: z.string().nullable().optional(), toWalletId: z.string().nullable().optional(), description: z.string().max(300).nullable().optional(),
      category: z.string().max(40).nullable().optional(), propertyId: z.string().nullable().optional(),
    }).parse(req.body);
    await addMovement(req.dbUserId!, req.params.id, d);
    res.status(201).json(await walletReport(req.dbUserId!));
  } catch (err) { fail(res, next)(err); }
});

// POST /checks/deposit { rentPaymentIds, bankAccountId, date } — checks taken to the bank (one deposit slip).
router.post('/checks/deposit', async (req, res, next) => {
  try {
    const d = z.object({ rentPaymentIds: z.array(z.string()).max(200).default([]), movementIds: z.array(z.string()).max(200).default([]), bankAccountId: z.string(), date: day })
      .refine(x => x.rentPaymentIds.length + x.movementIds.length > 0).parse(req.body);
    await depositChecks(req.dbUserId!, d.rentPaymentIds, d.bankAccountId, d.date, d.movementIds);
    res.json(await walletReport(req.dbUserId!));
  } catch (err) { fail(res, next)(err); }
});

// POST /checks/:rentPaymentId/undeposit — the check is on hand again.
router.post('/checks/:rentPaymentId/undeposit', async (req, res, next) => {
  try { await undoCheckDeposit(req.dbUserId!, req.params.rentPaymentId); res.json(await walletReport(req.dbUserId!)); } catch (err) { fail(res, next)(err); }
});

// PATCH /movements/:mid — what an entry was for (category, property), its wording, date or amount.
router.patch('/movements/:mid', async (req, res, next) => {
  try {
    const d = z.object({
      category: z.string().max(40).nullable().optional(), propertyId: z.string().nullable().optional(), description: z.string().max(300).nullable().optional(),
      date: day.optional(), amount: z.number().refine(n => n !== 0).optional(),
    }).parse(req.body);
    await updateMovement(req.dbUserId!, req.params.mid, d);
    res.json(await walletReport(req.dbUserId!));
  } catch (err) { fail(res, next)(err); }
});

router.delete('/movements/:mid', async (req, res, next) => {
  try { await deleteMovement(req.dbUserId!, req.params.mid); res.json(await walletReport(req.dbUserId!)); } catch (err) { fail(res, next)(err); }
});

export default router;
