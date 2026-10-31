import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { syncAllWatchedAccounts, CHANNEL_TO_METHOD, matchLease, extractCounterpartyName } from '../services/transactionMatchService';
import { recordRentPayment } from '../services/rentPaymentService';
import { findLoggedPayment, periodFor, sureOfTenant, descriptorMemo } from '../services/p2pPaymentEmails';

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
    const autoApplied = await applySureSuggestions(userId);
    let emailJobId: string | null = null;
    if (mailboxes) {
      const { gmailQueue } = await import('../workers/queues');
      const job = await gmailQueue.add('parse', { userId }, { attempts: 1 });
      emailJobId = job.id ?? null;
    }
    res.json({ ...result, autoApplied, mailboxes, emailJobId, startedAt: new Date().toISOString() });
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
    // Choosing the tenant saves the sender as that lease's payer name, so
    // their next payment is logged automatically (when it is certainly rent,
    // sureOfTenant). Moving it to another tenant takes back what was learned.
    if (tx.matchedLeaseId && tx.matchedLeaseId !== leaseId) await forgetSender(tx.matchedLeaseId, tx.name, tx.source);
    if (leaseId) await learnSender(leaseId, tx.name, tx.source);
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

    const { updated, linkedExisting } = await applyTo(tx, lease.id);
    if (!linkedExisting) await learnSender(lease.id, tx.name, tx.source);
    res.json({ ...updated, ...(linkedExisting ? { linkedExisting } : {}) });
  } catch (err) { next(err); }
});

type Tx = NonNullable<Awaited<ReturnType<typeof db.incomingTransaction.findFirst>>>;

/** Record a transaction as rent on a lease (or link it to the payment already logged by hand). */
async function applyTo(tx: Tx, leaseId: string) {
  // Logged by hand already: link it instead of logging the money twice.
  const logged = await findLoggedPayment(leaseId, Number(tx.amount), tx.date, { source: tx.source === 'email' ? 'email' : 'bank', reference: tx.confirmation ?? /\bREF\s*#?\s*(\S+)/i.exec(tx.name ?? '')?.[1] ?? null });
  if (logged) {
    const updated = await db.incomingTransaction.update({ where: { id: tx.id }, data: { status: 'APPLIED', rentPaymentId: logged.id } });
    return { updated, linkedExisting: true };
  }
  // Goes through the shared recorder so the payment splits against arrears
  // exactly like a hand-entered one, and carries the account it landed in.
  const payment = await recordRentPayment({
    leaseId,
    // The memo names the month when there is one; a bank row's is in its descriptor.
    periodDate: periodFor(tx.date, tx.memo ?? (tx.source === 'email' ? null : descriptorMemo(tx.name))),
    amount: Number(tx.amount),
    paidDate: tx.date,
    method: (CHANNEL_TO_METHOD[(tx.channel ?? 'OTHER') as keyof typeof CHANNEL_TO_METHOD] ?? 'OTHER') as any,
    bankAccountId: tx.bankAccountId ?? undefined,
    notes: [`Matched from ${tx.channel ?? 'bank'} ${tx.source === 'email' ? 'email' : 'transaction'}: "${tx.name}"`, tx.confirmation && `confirmation ${tx.confirmation}`, tx.memo && `memo "${tx.memo}"`].filter(Boolean).join(' · '),
  });
  const updated = await db.incomingTransaction.update({ where: { id: tx.id }, data: { status: 'APPLIED', rentPaymentId: payment.id } });
  return { updated, linkedExisting: false };
}

/**
 * Payments waiting as Suggested that the auto-log rule (sureOfTenant) now
 * covers — the rule was widened, or a payer name was saved since — are
 * applied on Sync now rather than left for the owner. Only where the name
 * still points at the lease already suggested.
 */
async function applySureSuggestions(userId: string): Promise<number> {
  const waiting = await db.incomingTransaction.findMany({ where: { userId, status: 'SUGGESTED', matchedLeaseId: { not: null } }, orderBy: { date: 'asc' } });
  let applied = 0;
  for (const tx of waiting) {
    try {
      const nameMatch = await matchLease(tx.source === 'email' ? (tx.name ?? '') : extractCounterpartyName(tx.name ?? ''), userId);
      if (!nameMatch || nameMatch.leaseId !== tx.matchedLeaseId) continue;
      const lease = await db.lease.findUnique({ where: { id: nameMatch.leaseId }, select: { rentAmount: true, arrearsBalance: true } });
      if (!sureOfTenant(nameMatch, lease, Number(tx.amount), tx.memo ?? (tx.source === 'email' ? null : descriptorMemo(tx.name)))) continue;
      await applyTo(tx, nameMatch.leaseId);
      applied++;
    } catch (err) {
      console.warn(`[Incoming] could not apply ${tx.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return applied;
}

/**
 * Applying a payment teaches Sollux the sender: the name becomes one of the
 * lease's payment aliases, so the next payment from them is logged without
 * asking. A clean name only: an email's payer, or the name inside a bank
 * descriptor; the rest of a descriptor ("REF # 123") is not a name.
 */
const LEARNED = 'Learned from a payment matched to this tenant';

/** The sender's name in a transaction: an email's payer, or the name between FROM and ON in a bank descriptor ("ZELLE FROM JANE SAMPLE ON 10/01 REF # ..."). */
function senderName(name: string | null, source: string | null): string | null {
  const raw = source === 'email' ? name : /\bfrom\s+(.+?)\s+on\s+\d/i.exec(name ?? '')?.[1];
  const clean = (raw ?? '').trim();
  return !clean || /\d/.test(clean) || clean.split(/\s+/).length > 6 ? null : clean;
}

async function learnSender(leaseId: string, name: string | null, source: string | null) {
  const clean = senderName(name, source);
  if (!clean) return;
  // Already recognised as this tenant (their own name or a saved payer): nothing to learn.
  const already = await matchLease(clean, (await db.lease.findUnique({ where: { id: leaseId }, select: { unit: { select: { property: { select: { userId: true } } } } } }))?.unit.property.userId ?? '');
  if (already?.leaseId === leaseId && already.exact) return;
  const known = await db.leasePaymentAlias.findFirst({ where: { leaseId, name: { equals: clean, mode: 'insensitive' } }, select: { id: true } });
  if (!known) await db.leasePaymentAlias.create({ data: { leaseId, name: clean, note: LEARNED } }).catch(() => {});
}

/** Undo learnSender when a payment is moved off a tenant it was wrongly matched to. Names the owner typed are kept. */
async function forgetSender(leaseId: string, name: string | null, source: string | null) {
  const clean = senderName(name, source);
  if (clean) await db.leasePaymentAlias.deleteMany({ where: { leaseId, note: LEARNED, name: { equals: clean, mode: 'insensitive' } } });
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
