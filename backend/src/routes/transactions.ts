import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { syncAllWatchedAccounts, CHANNEL_TO_METHOD } from '../services/transactionMatchService';
import { recordRentPayment } from '../services/rentPaymentService';
import { findLoggedPayment, periodFor } from '../services/p2pPaymentEmails';

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

// POST /sync — pull new transactions for every watched account, and read the
// connected mailboxes for Zelle / Venmo / Cash App emails. Payment emails
// were only read by the nightly inbox run, so a payment that arrived today
// was missing after "Sync now" until the next morning.
router.post('/sync', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;
    const [result, mailboxes] = await Promise.all([
      syncAllWatchedAccounts(userId),
      db.gmailToken.count({ where: { userId } }),
    ]);
    let emailJobId: string | null = null;
    if (mailboxes) {
      const { gmailQueue } = await import('../workers/queues');
      const job = await gmailQueue.add('parse', { userId }, { attempts: 1 });
      emailJobId = job.id ?? null;
    }
    res.json({ ...result, mailboxes, emailJobId, startedAt: new Date().toISOString() });
  } catch (err) { next(err); }
});

// GET /sync/email/:jobId?since= — whether the mailbox read has finished, and
// the payment emails it handled (each says where the payment went: suggested,
// unmatched, already on record).
router.get('/sync/email/:jobId', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;
    const { gmailQueue } = await import('../workers/queues');
    const job = await gmailQueue.getJob(req.params.jobId);
    if (!job || job.data.userId !== userId) return res.status(404).json({ error: 'Not found' });
    const state = await job.getState();
    const done = state === 'completed' || state === 'failed' || state === 'unknown';
    const since = new Date(typeof req.query.since === 'string' ? req.query.since : Date.now() - 3600 * 1000);
    const payments = done ? await db.inboxMessage.findMany({
      where: { userId, outcome: 'payment', createdAt: { gte: since } },
      orderBy: { receivedAt: 'desc' }, take: 20,
      select: { subject: true, detail: true, receivedAt: true },
    }) : [];
    res.json({ done, failed: state === 'failed' ? (job.failedReason ?? 'failed') : null, payments });
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
    // Logged by hand already: link it instead of logging the money twice.
    const logged = await findLoggedPayment(lease.id, Number(tx.amount), tx.date);
    if (logged) {
      const linked = await db.incomingTransaction.update({ where: { id: tx.id }, data: { status: 'APPLIED', rentPaymentId: logged.id } });
      return res.json({ ...linked, linkedExisting: true });
    }

    const payment = await recordRentPayment({
      leaseId: lease.id,
      periodDate: periodFor(tx.date, tx.memo),
      amount: Number(tx.amount),
      paidDate: tx.date,
      method: (CHANNEL_TO_METHOD[(tx.channel ?? 'OTHER') as keyof typeof CHANNEL_TO_METHOD] ?? 'OTHER') as any,
      bankAccountId: tx.bankAccountId ?? undefined,
      notes: [`Matched from ${tx.channel ?? 'bank'} ${tx.source === 'email' ? 'email' : 'transaction'}: "${tx.name}"`, tx.confirmation && `confirmation ${tx.confirmation}`, tx.memo && `memo "${tx.memo}"`].filter(Boolean).join(' · '),
    });

    const updated = await db.incomingTransaction.update({
      where: { id: tx.id },
      data: { status: 'APPLIED', rentPaymentId: payment.id },
    });
    await learnSender(lease.id, tx.name, tx.source);
    res.json(updated);
  } catch (err) { next(err); }
});

/**
 * Applying a payment teaches Sollux the sender: the name becomes one of the
 * lease's payment aliases, so the next payment from them is logged without
 * asking. Only a clean name from an email; a bank descriptor
 * ("ZELLE FROM ... REF #123") is not a name.
 */
async function learnSender(leaseId: string, name: string | null, source: string | null) {
  const clean = (name ?? '').trim();
  if (source !== 'email' || !clean || /\d/.test(clean) || clean.split(/\s+/).length > 6) return;
  const known = await db.leasePaymentAlias.findFirst({ where: { leaseId, name: { equals: clean, mode: 'insensitive' } }, select: { id: true } });
  if (!known) await db.leasePaymentAlias.create({ data: { leaseId, name: clean, note: 'Learned when a payment from this sender was applied' } }).catch(() => {});
}

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
