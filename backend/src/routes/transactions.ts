import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { syncAllWatchedAccounts, CHANNEL_TO_METHOD, matchLease, extractCounterpartyName } from '../services/transactionMatchService';
import { recordRentPayment } from '../services/rentPaymentService';
import { findLoggedPayment, periodFor, rentMonthFor, sureOfSender, descriptorMemo } from '../services/p2pPaymentEmails';
import { logIncomingRent, logIncomingUtilities, autoLogIncoming, utilityInvoiceFor, leaseUtilityInvoices, memoSaysUtilities, type ExtraChoice } from '../services/incomingRent';

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
    // The month Apply records each one for, so the owner sees it (and can change it) before applying.
    // Waiting ones with a tenant also skip a month that tenant has already paid in full (rentMonthFor).
    res.json(await Promise.all(transactions.map(async tx => ({
      ...tx,
      // Waiting ones from a tenant with an open utility invoice: offered as utilities when the memo
      // says so or the amount is that invoice's.
      utilities: tx.status !== 'APPLIED' && tx.status !== 'IGNORED' && tx.matchedLeaseId
        ? await (async () => {
            const inv = await utilityInvoiceFor(tx.matchedLeaseId!, tx.userId, Number(tx.amount));
            const invoices = await leaseUtilityInvoices(tx.matchedLeaseId!);
            if (!inv && !invoices.length) return null;
            return { ...(inv ?? { invoiceId: null, outstanding: 0, label: '', exact: false }), suggested: !!inv?.exact || memoSaysUtilities(memoOf(tx)), invoices };
          })()
        : null,
      forMonth: (tx.status !== 'APPLIED' && tx.status !== 'IGNORED' && tx.matchedLeaseId
        ? await rentMonthFor(tx.matchedLeaseId, tx.date, memoOf(tx))
        : periodFor(tx.date, memoOf(tx))).toISOString().slice(0, 7),
    }))));
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

    // The owner can name the month ("October"); a named month takes the payment first, before arrears.
    const forMonth = typeof req.body?.forMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.body.forMonth) ? req.body.forMonth as string : null;
    // Paid back utilities, not rent: recorded on the lease's open utility invoice.
    if (req.body?.as === 'utilities') {
      const logged = await findLoggedPayment(lease.id, Number(tx.amount), tx.date, { source: tx.source === 'email' ? 'email' : 'bank', reference: tx.confirmation ?? null });
      if (logged) return res.status(409).json({ error: 'This transfer is already logged as rent. Delete that rent payment first.' });
      const { note } = await logIncomingUtilities({ ...txInput(tx, lease.id), invoiceId: typeof req.body?.invoiceId === 'string' ? req.body.invoiceId : null });
      await learnSender(lease.id, tx.name, tx.source);
      return res.json({ ...(await db.incomingTransaction.findUniqueOrThrow({ where: { id: tx.id } })), reviewNote: note });
    }
    const choice = (['next', 'arrears', 'utilities'] as const).find(c => c === req.body?.extraTo) ?? null;
    const { updated, linkedExisting, plan } = await applyTo(tx, lease.id, forMonth, choice);
    // More than the month owes, with back rent or utilities open: the owner says where the extra goes.
    if (plan) return res.status(409).json({ needsChoice: true, plan, error: plan.note });
    if (!linkedExisting) await learnSender(lease.id, tx.name, tx.source);
    res.json({ ...updated, ...(linkedExisting ? { linkedExisting } : {}) });
  } catch (err) { next(err); }
});

type Tx = NonNullable<Awaited<ReturnType<typeof db.incomingTransaction.findFirst>>>;

/** Record a transaction as rent on a lease (or link it to the payment already logged by hand). */
const memoOf = (tx: { memo: string | null; source: string | null; name: string | null }) => tx.memo ?? (tx.source === 'email' ? null : descriptorMemo(tx.name));

const txInput = (tx: Tx, leaseId: string) => ({
  txId: tx.id, userId: tx.userId, leaseId,
  amount: Number(tx.amount), date: tx.date, memo: memoOf(tx),
  method: CHANNEL_TO_METHOD[(tx.channel ?? 'OTHER') as keyof typeof CHANNEL_TO_METHOD] ?? 'OTHER',
  bankAccountId: tx.bankAccountId,
  notes: [`Matched from ${tx.channel ?? 'bank'} ${tx.source === 'email' ? 'email' : 'transaction'}: "${tx.name}"`, tx.confirmation && `confirmation ${tx.confirmation}`, tx.memo && `memo "${tx.memo}"`].filter(Boolean).join(' · '),
});

async function applyTo(tx: Tx, leaseId: string, forMonth?: string | null, choice?: ExtraChoice | null) {
  // Logged by hand already: link it instead of logging the money twice.
  const logged = await findLoggedPayment(leaseId, Number(tx.amount), tx.date, { source: tx.source === 'email' ? 'email' : 'bank', reference: tx.confirmation ?? /\bREF\s*#?\s*(\S+)/i.exec(tx.name ?? '')?.[1] ?? null });
  if (logged) {
    const updated = await db.incomingTransaction.update({ where: { id: tx.id }, data: { status: 'APPLIED', rentPaymentId: logged.id } });
    return { updated, linkedExisting: true, plan: null };
  }
  // The month the owner chose, else the memo's or the date's (rentMonthFor); more
  // than the month owes goes where incomingRent decides, or where the owner chose.
  const r = await logIncomingRent({ ...txInput(tx, leaseId), forMonth, choice });
  const updated = await db.incomingTransaction.findUniqueOrThrow({ where: { id: tx.id } });
  return { updated, linkedExisting: false, plan: r.applied ? null : r.plan };
}

/**
 * Payments waiting as Suggested that the auto-log rule (sureOfTenant) now
 * covers — the rule was widened, or a payer name was saved since — are
 * applied on Sync now rather than left for the owner. Only where the name
 * still points at the lease already suggested.
 */
async function applySureSuggestions(userId: string): Promise<number> {
  // One waiting for the owner's choice about an overpayment (reviewNote) stays waiting.
  const waiting = await db.incomingTransaction.findMany({ where: { userId, status: 'SUGGESTED', matchedLeaseId: { not: null }, reviewNote: null }, orderBy: { date: 'asc' } });
  let applied = 0;
  for (const tx of waiting) {
    try {
      const nameMatch = await matchLease(tx.source === 'email' ? (tx.name ?? '') : extractCounterpartyName(tx.name ?? ''), userId);
      if (!nameMatch || nameMatch.leaseId !== tx.matchedLeaseId) continue;
      if (await findLoggedPayment(nameMatch.leaseId, Number(tx.amount), tx.date, { source: tx.source === 'email' ? 'email' : 'bank', reference: tx.confirmation ?? null })) continue;
      const did = await autoLogIncoming(txInput(tx, nameMatch.leaseId), sureOfSender(nameMatch, memoOf(tx)));
      if (did !== 'waiting') applied++;
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
