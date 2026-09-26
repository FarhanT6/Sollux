import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { syncAllWatchedAccounts, findUtilityCandidates } from '../services/transactionMatchService';
import { findLoanCandidates, logLoanPaymentFromTransaction } from '../services/loanPaymentMatcher';

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
    // Loan matches carry the lender's name for the list.
    const loanIds = [...new Set(transactions.map(t => t.loanId).filter((x): x is string => !!x))];
    const loans = loanIds.length ? await db.loan.findMany({ where: { id: { in: loanIds }, userId: req.dbUserId! }, select: { id: true, lender: true } }) : [];
    const lender = new Map(loans.map(l => [l.id, l.lender]));
    res.json(transactions.map(t => ({ ...t, loan: t.loanId ? { id: t.loanId, lender: lender.get(t.loanId) ?? 'Loan' } : null })));
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

// GET /:id/loan-candidates — loans this debit could be a payment on, best first.
router.get('/:id/loan-candidates', async (req, res, next) => {
  try {
    const tx = await db.outgoingTransaction.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    const named = await findLoanCandidates(tx.name, Number(tx.amount), req.dbUserId!, tx.bankAccountId);
    // Always offer every active loan after the likely ones, so any debit can be assigned.
    const all = await db.loan.findMany({ where: { userId: req.dbUserId!, isActive: true }, select: { id: true, lender: true, monthlyPayment: true, escrowAmount: true }, orderBy: { lender: 'asc' } });
    const seen = new Set(named.map(c => c.loanId));
    res.json([
      ...named.map(c => ({ loanId: c.loanId, lender: c.lender, expected: c.expected, likely: true })),
      ...all.filter(l => !seen.has(l.id)).map(l => ({ loanId: l.id, lender: l.lender, expected: Number(l.monthlyPayment ?? 0) + Number(l.escrowAmount ?? 0), likely: false })),
    ]);
  } catch (err) { next(err); }
});

// PATCH /:id — set/override property, utility account/statement, or category before applying
router.patch('/:id', async (req, res, next) => {
  try {
    const tx = await db.outgoingTransaction.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status === 'APPLIED') return res.status(400).json({ error: 'Already applied — cannot re-match' });

    const { propertyId, category, utilityAccountId, statementId, loanId } = req.body as {
      propertyId?: string | null; category?: string | null; utilityAccountId?: string | null; statementId?: string | null; loanId?: string | null;
    };
    if (loanId) {
      const loan = await db.loan.findFirst({ where: { id: loanId, userId: req.dbUserId! }, select: { id: true, propertyId: true } });
      if (!loan) return res.status(404).json({ error: 'Loan not found' });
      const updated = await db.outgoingTransaction.update({ where: { id: tx.id }, data: { matchType: 'LOAN', loanId: loan.id, propertyId: loan.propertyId, status: 'SUGGESTED' } });
      return res.json(updated);
    }

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
    // A loan payment goes to the loan tracker; a personal loan has no property.
    if (tx.matchType === 'LOAN' && tx.loanId) {
      const paymentId = await logLoanPaymentFromTransaction(tx, tx.loanId, req.dbUserId!);
      const updated = await db.outgoingTransaction.update({ where: { id: tx.id }, data: { status: 'APPLIED', appliedType: 'LOAN_PAYMENT', appliedId: paymentId } });
      return res.json(updated);
    }
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
