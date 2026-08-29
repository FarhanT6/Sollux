import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { syncAllWatchedAccounts, CHANNEL_TO_METHOD } from '../services/transactionMatchService';
import { recordRentPayment, periodStartOf } from '../services/rentPaymentService';

const router = Router();
router.use(attachDbUser);

// GET / — list incoming transactions, optionally filtered by status
router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    const transactions = await db.incomingTransaction.findMany({
      where: { userId: req.dbUserId!, ...(status ? { status: status as string } : {}) },
      include: {
        bankAccount: { select: { id: true, name: true, bank: true } },
        matchedLease: {
          select: {
            id: true,
            unit: { select: { unitLabel: true, property: { select: { id: true, address: true, nickname: true } } } },
            leaseTenants: { include: { tenant: { select: { fullName: true } } } },
          },
        },
      },
      orderBy: { date: 'desc' },
    });
    res.json(transactions);
  } catch (err) { next(err); }
});

// POST /sync — pull new transactions for every watched account
router.post('/sync', async (req, res, next) => {
  try {
    const result = await syncAllWatchedAccounts(req.dbUserId!);
    res.json(result);
  } catch (err) { next(err); }
});

// PATCH /:id — manually set/override which lease this transaction matches
router.patch('/:id', async (req, res, next) => {
  try {
    const tx = await db.incomingTransaction.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status === 'APPLIED') return res.status(400).json({ error: 'Already applied — cannot re-match' });

    const { leaseId } = req.body as { leaseId: string | null };
    if (leaseId) {
      const lease = await db.lease.findFirst({ where: { id: leaseId, unit: { property: { userId: req.dbUserId! } } } });
      if (!lease) return res.status(404).json({ error: 'Lease not found' });
    }

    const updated = await db.incomingTransaction.update({
      where: { id: tx.id },
      data: { matchedLeaseId: leaseId, status: leaseId ? 'SUGGESTED' : 'UNMATCHED' },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /:id/apply — create the real RentPayment for this transaction
router.post('/:id/apply', async (req, res, next) => {
  try {
    const tx = await db.incomingTransaction.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status === 'APPLIED') return res.status(400).json({ error: 'Already applied' });
    if (!tx.matchedLeaseId) return res.status(400).json({ error: 'No lease matched — set one first' });

    const lease = await db.lease.findFirst({ where: { id: tx.matchedLeaseId, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Matched lease not found' });

    // Goes through the shared recorder so an auto-applied payment splits
    // against arrears exactly like a hand-entered one, and carries the account
    // the money actually landed in.
    const payment = await recordRentPayment({
      leaseId: lease.id,
      periodDate: periodStartOf(tx.date),
      amount: Number(tx.amount),
      paidDate: tx.date,
      method: (CHANNEL_TO_METHOD[(tx.channel ?? 'OTHER') as keyof typeof CHANNEL_TO_METHOD] ?? 'OTHER') as any,
      bankAccountId: tx.bankAccountId,
      notes: `Auto-matched from ${tx.channel ?? 'bank'} transaction: "${tx.name}"`,
    });

    const updated = await db.incomingTransaction.update({
      where: { id: tx.id },
      data: { status: 'APPLIED', rentPaymentId: payment.id },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /:id/ignore — not rent, don't ask again
router.post('/:id/ignore', async (req, res, next) => {
  try {
    const tx = await db.incomingTransaction.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status === 'APPLIED') return res.status(400).json({ error: 'Already applied' });
    const updated = await db.incomingTransaction.update({ where: { id: tx.id }, data: { status: 'IGNORED' } });
    res.json(updated);
  } catch (err) { next(err); }
});

export default router;
