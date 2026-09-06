/**
 * Tenant utility reimbursement: per-lease rules, previewed and generated
 * invoices, and what the tenant paid against them.
 */
import { Router } from 'express';
import { z } from 'zod';
import { attachDbUser } from '../middleware/requireAuth';
import * as r from '../services/reimbursement';

const router = Router();
router.use(attachDbUser);

const fail = (res: import('express').Response, err: unknown) => {
  if (err instanceof r.ReimbursementError) return res.status(err.status).json({ error: err.message });
  console.error('[Reimbursement]', err instanceof Error ? err.message : err);
  return res.status(500).json({ error: 'Something went wrong.' });
};

const RuleSchema = z.object({
  category: z.string().min(1),
  mode: z.enum(['PERCENT', 'FULL', 'FLAT_MONTHLY']),
  value: z.number().min(0),
  label: z.string().optional(),
});

router.get('/lease/:leaseId', async (req, res) => {
  try { res.json(await r.getConfig(req.params.leaseId, req.dbUserId!)); } catch (err) { fail(res, err); }
});

router.put('/lease/:leaseId', async (req, res) => {
  const parsed = z.object({
    enabled: z.boolean(),
    rules: z.array(RuleSchema),
    accountIds: z.array(z.string()).optional(),
    notes: z.string().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid reimbursement rules.' });
  try { res.json(await r.upsertConfig(req.params.leaseId, req.dbUserId!, parsed.data)); } catch (err) { fail(res, err); }
});

const Range = z.object({ from: z.string().min(10), to: z.string().min(10), exclude: z.array(z.string()).optional() });

router.post('/lease/:leaseId/preview', async (req, res) => {
  const parsed = Range.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a date range.' });
  try { res.json(await r.draftInvoice(req.params.leaseId, req.dbUserId!, parsed.data.from, parsed.data.to, parsed.data.exclude ?? [])); } catch (err) { fail(res, err); }
});

router.post('/lease/:leaseId/invoices', async (req, res) => {
  const parsed = Range.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a date range.' });
  try { res.status(201).json(await r.createInvoice(req.params.leaseId, req.dbUserId!, parsed.data.from, parsed.data.to, parsed.data.exclude ?? [])); } catch (err) { fail(res, err); }
});

router.get('/letterhead', async (req, res) => {
  try { res.json(await r.getLetterhead(req.dbUserId!)); } catch (err) { fail(res, err); }
});

router.put('/letterhead', async (req, res) => {
  const parsed = z.object({
    name: z.string().min(1),
    address: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'The letterhead needs a name.' });
  try { res.json(await r.upsertLetterhead(req.dbUserId!, parsed.data)); } catch (err) { fail(res, err); }
});

router.get('/invoices/:id', async (req, res) => {
  try { res.json(await r.getInvoice(req.params.id, req.dbUserId!)); } catch (err) { fail(res, err); }
});

router.post('/invoices/:id/payment', async (req, res) => {
  const parsed = z.object({ amount: z.number().positive(), paidAt: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter an amount greater than zero.' });
  try { res.json(await r.recordPayment(req.params.id, req.dbUserId!, parsed.data.amount, parsed.data.paidAt)); } catch (err) { fail(res, err); }
});

router.patch('/invoices/:id', async (req, res) => {
  const parsed = z.object({ status: z.enum(['DRAFT', 'SENT']), notes: z.string().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid update.' });
  try { res.json(await r.setStatus(req.params.id, req.dbUserId!, parsed.data.status, parsed.data.notes)); } catch (err) { fail(res, err); }
});

router.delete('/invoices/:id', async (req, res) => {
  try { await r.deleteInvoice(req.params.id, req.dbUserId!); res.status(204).send(); } catch (err) { fail(res, err); }
});

export default router;
