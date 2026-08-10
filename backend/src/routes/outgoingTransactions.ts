import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { syncAllWatchedAccounts, findUtilityCandidates } from '../services/transactionMatchService';

const router = Router();
router.use(attachDbUser);

// GET / — list outgoing (expense) transactions, optionally filtered by status
router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    const transactions = await db.outgoingTransaction.findMany({
      where: { userId: req.dbUserId!, ...(status ? { status: status as string } : {}) },
      include: {
        bankAccount: { select: { id: true, name: true, bank: true } },
        property: { select: { id: true, address: true, nickname: true } },
        utilityAccount: { select: { id: true, providerName: true } },
      },
      orderBy: { date: 'desc' },
    });
    res.json(transactions);
  } catch (err) { next(err); }
});

// POST /sync — shares the same sync pass as incoming transactions (see
// transactionMatchService for why: Plaid's cursor is per-Item, not per-purpose)
router.post('/sync', async (req, res, next) => {
  try {
    const result = await syncAllWatchedAccounts(req.dbUserId!);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /:id/utility-candidates — every unpaid statement on a provider-matched
// utility account, closest-amount first, for the manual vetting picker.
router.get('/:id/utility-candidates', async (req, res, next) => {
  try {
    const tx = await db.outgoingTransaction.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    const candidates = await findUtilityCandidates(tx.name, Number(tx.amount), req.dbUserId!);
    res.json(candidates);
  } catch (err) { next(err); }
});

// PATCH /:id — set/override property, utility account/statement, or category before applying
router.patch('/:id', async (req, res, next) => {
  try {
    const tx = await db.outgoingTransaction.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status === 'APPLIED') return res.status(400).json({ error: 'Already applied — cannot re-match' });

    const { propertyId, category, utilityAccountId, statementId } = req.body as {
      propertyId?: string | null; category?: string | null; utilityAccountId?: string | null; statementId?: string | null;
    };

    if (propertyId) {
      const prop = await db.property.findFirst({ where: { id: propertyId, userId: req.dbUserId! } });
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }
    if (utilityAccountId) {
      const acct = await db.utilityAccount.findFirst({ where: { id: utilityAccountId, property: { userId: req.dbUserId! } } });
      if (!acct) return res.status(404).json({ error: 'Utility account not found' });
    }
    if (statementId) {
      const stmt = await db.statement.findFirst({ where: { id: statementId, utilityAccount: { property: { userId: req.dbUserId! } } } });
      if (!stmt) return res.status(404).json({ error: 'Statement not found' });
    }

    const nextPropertyId = propertyId !== undefined ? propertyId : tx.propertyId;
    const updated = await db.outgoingTransaction.update({
      where: { id: tx.id },
      data: {
        propertyId: nextPropertyId,
        category: category !== undefined ? category : tx.category,
        utilityAccountId: utilityAccountId !== undefined ? utilityAccountId : tx.utilityAccountId,
        statementId: statementId !== undefined ? statementId : tx.statementId,
        status: nextPropertyId ? 'SUGGESTED' : 'UNMATCHED',
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /:id/apply — mark the matched statement paid, or create an Expense
router.post('/:id/apply', async (req, res, next) => {
  try {
    const tx = await db.outgoingTransaction.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status === 'APPLIED') return res.status(400).json({ error: 'Already applied' });
    if (!tx.propertyId) return res.status(400).json({ error: 'No property matched — set one first' });

    const property = await db.property.findFirst({ where: { id: tx.propertyId, userId: req.dbUserId! } });
    if (!property) return res.status(404).json({ error: 'Property not found' });

    let appliedType: string;
    let appliedId: string;

    if (tx.matchType === 'UTILITY' && tx.statementId) {
      const statement = await db.statement.findUnique({ where: { id: tx.statementId } });
      if (statement && statement.amountPaid == null) {
        const updated = await db.statement.update({
          where: { id: statement.id },
          data: { amountPaid: tx.amount },
        });
        appliedType = 'STATEMENT';
        appliedId = updated.id;
      } else {
        // Statement already got paid another way since this was suggested — fall back to an Expense.
        const expense = await db.expense.create({
          data: {
            userId: req.dbUserId!,
            propertyId: property.id,
            category: 'UTILITIES',
            amount: tx.amount,
            date: tx.date,
            vendor: tx.name,
            description: `Auto-matched from bank transaction "${tx.name}" (open statement no longer available)`,
            isCapEx: false,
            isPersonal: false,
          },
        });
        appliedType = 'EXPENSE';
        appliedId = expense.id;
      }
    } else {
      const expense = await db.expense.create({
        data: {
          userId: req.dbUserId!,
          propertyId: property.id,
          category: (tx.category ?? 'REPAIRS_MAINTENANCE') as any,
          amount: tx.amount,
          date: tx.date,
          vendor: tx.name,
          description: `Auto-matched from bank transaction: "${tx.name}"`,
          isCapEx: false,
          isPersonal: false,
        },
      });
      appliedType = 'EXPENSE';
      appliedId = expense.id;
    }

    const updated = await db.outgoingTransaction.update({
      where: { id: tx.id },
      data: { status: 'APPLIED', appliedType, appliedId },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /:id/ignore
router.post('/:id/ignore', async (req, res, next) => {
  try {
    const tx = await db.outgoingTransaction.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status === 'APPLIED') return res.status(400).json({ error: 'Already applied' });
    const updated = await db.outgoingTransaction.update({ where: { id: tx.id }, data: { status: 'IGNORED' } });
    res.json(updated);
  } catch (err) { next(err); }
});

export default router;
