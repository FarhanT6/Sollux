/**
 * Credit cards: each card's terms, statements (read in full, every
 * transaction), payments and transactions, and its live position. Personal
 * finance, kept apart from the rental portfolio — a charge that was for a
 * property can be moved into that property's expenses from here.
 *
 * Card numbers are never stored: last four digits only.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument, getSignedDocumentUrl } from '../services/s3Service';
import { readDocument } from '../services/documentReader';
import { cardPosition, portfolio } from '../services/creditCards';

const router = Router();
router.use(attachDbUser);

const day = z.string().nullable().optional().transform(s => (s ? new Date(s) : s === null ? null : undefined));
const money = z.number().nullable().optional();
const File = z.object({ name: z.string(), data: z.string() });
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);

const CardFields = z.object({
  name: z.string().min(1),
  issuer: z.string().nullable().optional(),
  network: z.string().nullable().optional(),
  last4: z.string().regex(/^\d{4}$/).nullable().optional(),
  cardholderName: z.string().nullable().optional(),
  isBusiness: z.boolean().optional(),
  propertyId: z.string().nullable().optional(),
  bankAccountId: z.string().nullable().optional(),
  status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']).optional(),
  openedDate: day, closedDate: day,
  expiration: z.string().regex(/^\d{2}\/\d{2}$/).nullable().optional(),
  creditLimit: money, cashAdvanceLimit: money, currentBalance: money, balanceAsOf: day,
  statementClosingDay: z.number().int().min(1).max(31).nullable().optional(),
  paymentDueDay: z.number().int().min(1).max(31).nullable().optional(),
  purchaseApr: money, cashAdvanceApr: money, balanceTransferApr: money, penaltyApr: money,
  introApr: money, introAprType: z.enum(['PURCHASE', 'BALANCE_TRANSFER', 'BOTH']).nullable().optional(), introAprEndDate: day,
  annualFee: money, annualFeeMonth: z.number().int().min(1).max(12).nullable().optional(),
  foreignTransactionFee: money, lateFee: money, balanceTransferFee: money, cashAdvanceFee: money,
  rewardsProgram: z.string().nullable().optional(), rewardsType: z.enum(['POINTS', 'MILES', 'CASHBACK']).nullable().optional(),
  rewardsBalance: money, rewardsCentsPerPoint: money, rewardsEarnRates: z.string().nullable().optional(),
  autopay: z.enum(['NONE', 'MINIMUM', 'STATEMENT_BALANCE', 'FULL_BALANCE', 'FIXED']).optional(),
  autopayAmount: money, autopayFromBankAccountId: z.string().nullable().optional(),
  authorizedUsers: z.array(z.object({ name: z.string(), last4: z.string().nullable().optional() })).nullable().optional(),
  loginUrl: z.string().nullable().optional(), phone: z.string().nullable().optional(), notes: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const StatementFields = z.object({
  periodStart: day, closingDate: z.string().transform(s => new Date(s)), dueDate: day,
  previousBalance: money, paymentsCredits: money, purchases: money, balanceTransfers: money, cashAdvances: money,
  feesCharged: money, interestCharged: money, newBalance: z.number(), minimumPayment: money, creditLimit: money,
  availableCredit: money, purchaseApr: money, cashAdvanceApr: money, rewardsEarned: money, rewardsBalance: money,
  daysInCycle: z.number().int().nullable().optional(), minPayoffMonths: z.number().int().nullable().optional(), minPayoffTotal: money,
});

const TxnFields = z.object({
  date: z.string(), postDate: z.string().nullable().optional(), description: z.string().min(1), merchant: z.string().nullable().optional(),
  amount: z.number(), kind: z.enum(['PURCHASE', 'PAYMENT', 'CREDIT', 'FEE', 'INTEREST', 'CASH_ADVANCE', 'BALANCE_TRANSFER']).optional(),
  category: z.string().nullable().optional(), cardholder: z.string().nullable().optional(),
});

async function ownedCard(id: string, userId: string) {
  return db.creditCard.findFirst({ where: { id, userId } });
}
async function checkRefs(userId: string, d: { propertyId?: string | null; bankAccountId?: string | null; autopayFromBankAccountId?: string | null }) {
  if (d.propertyId && !(await db.property.findFirst({ where: { id: d.propertyId, userId }, select: { id: true } }))) return 'Property not found';
  for (const b of [d.bankAccountId, d.autopayFromBankAccountId]) {
    if (b && !(await db.bankAccount.findFirst({ where: { id: b, userId }, select: { id: true } }))) return 'Bank account not found';
  }
  return null;
}
const withPosition = (c: any) => ({ ...c, position: cardPosition(c) });

// GET / — every card with its position, the totals, and payment-source cards not yet set up here.
router.get('/', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;
    const cards = await db.creditCard.findMany({
      where: { userId },
      include: { statements: { orderBy: { closingDate: 'desc' }, take: 13 }, payments: { orderBy: { date: 'desc' }, take: 20 } },
      orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const rows = cards.map(withPosition).map(({ statements, payments, ...c }: any) => ({ ...c, statementCount: statements.length }));
    const linked = new Set(cards.map(c => c.bankAccountId).filter(Boolean));
    const unlinked = await db.bankAccount.findMany({
      where: { userId, accountType: 'CREDIT_CARD', isActive: true },
      select: { id: true, name: true, last4: true, bank: true, cardNetwork: true, cardExpiry: true },
    });
    res.json({ cards: rows, summary: portfolio(rows), paymentSourceCards: unlinked.filter(b => !linked.has(b.id)) });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = CardFields.parse(req.body);
    const bad = await checkRefs(req.dbUserId!, data);
    if (bad) return res.status(404).json({ error: bad });
    res.status(201).json(await db.creditCard.create({ data: { ...(data as any), userId: req.dbUserId! } }));
  } catch (err) { next(err); }
});

// POST /from-bank-account/:bankAccountId — set up a card from its payment-source entry.
router.post('/from-bank-account/:bankAccountId', async (req, res, next) => {
  try {
    const b = await db.bankAccount.findFirst({ where: { id: req.params.bankAccountId, userId: req.dbUserId! } });
    if (!b) return res.status(404).json({ error: 'Not found' });
    const card = await db.creditCard.create({
      data: {
        userId: req.dbUserId!, name: b.name, issuer: b.bank, network: b.cardNetwork, last4: b.last4 && /^\d{4}$/.test(b.last4) ? b.last4 : null,
        expiration: b.cardExpiry && /^\d{2}\/\d{2}$/.test(b.cardExpiry) ? b.cardExpiry : null, bankAccountId: b.id,
      },
    });
    res.status(201).json(card);
  } catch (err) { next(err); }
});

// POST /read-statement — read a statement's pages; match the card by its last four.
router.post('/read-statement', async (req, res, next) => {
  try {
    const { files } = z.object({ files: z.array(File).min(1).max(20) }).parse(req.body);
    const result = await readDocument('card_statement', files, req.dbUserId!);
    const last4 = result.fields.last4;
    const card = last4 ? await db.creditCard.findFirst({ where: { userId: req.dbUserId!, last4 }, select: { id: true, name: true } }) : null;
    res.json({ fields: result.fields, cardId: card?.id ?? null, cardName: card?.name ?? null });
  } catch (err: any) {
    if (err?.message) return res.status(422).json({ error: err.message });
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const card = await db.creditCard.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
      include: {
        statements: { orderBy: { closingDate: 'desc' }, include: { _count: { select: { transactions: true } } } },
        payments: { orderBy: { date: 'desc' } },
      },
    });
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const banks = await db.bankAccount.findMany({ where: { userId: req.dbUserId! }, select: { id: true, name: true, last4: true } });
    const bankName = new Map(banks.map(b => [b.id, b.last4 ? `${b.name} ••${b.last4}` : b.name]));
    // Spending by category over the last 12 months, from the transactions.
    const since = new Date(Date.now() - 365 * 86400000);
    const txns = await db.cardTransaction.findMany({ where: { cardId: card.id, date: { gte: since } }, select: { amount: true, category: true, kind: true, date: true } });
    const byCategory: Record<string, number> = {};
    const byMonth: Record<string, number> = {};
    for (const t of txns) {
      if (!['PURCHASE', 'CASH_ADVANCE'].includes(t.kind)) continue;
      const k = t.category || 'Other';
      byCategory[k] = Number(((byCategory[k] ?? 0) + Number(t.amount)).toFixed(2));
      const m = t.date.toISOString().slice(0, 7);
      byMonth[m] = Number(((byMonth[m] ?? 0) + Number(t.amount)).toFixed(2));
    }
    res.json({
      ...withPosition(card),
      statements: card.statements.map(s => ({ ...s, transactionCount: s._count.transactions, hasDocument: Array.isArray(s.documents) && (s.documents as any[]).length > 0, documents: undefined })),
      payments: card.payments.map(p => ({ ...p, fromBankAccountName: p.fromBankAccountId ? bankName.get(p.fromBankAccountId) ?? null : null })),
      autopayFromName: card.autopayFromBankAccountId ? bankName.get(card.autopayFromBankAccountId) ?? null : null,
      spending: { byCategory, byMonth },
    });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    if (!(await ownedCard(req.params.id, req.dbUserId!))) return res.status(404).json({ error: 'Card not found' });
    const data = CardFields.partial().parse(req.body);
    const bad = await checkRefs(req.dbUserId!, data);
    if (bad) return res.status(404).json({ error: bad });
    // A balance typed in is dated today unless a date was given.
    if (data.currentBalance !== undefined && data.balanceAsOf === undefined) (data as any).balanceAsOf = data.currentBalance == null ? null : new Date();
    res.json(await db.creditCard.update({ where: { id: req.params.id }, data: data as any }));
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!(await ownedCard(req.params.id, req.dbUserId!))) return res.status(404).json({ error: 'Card not found' });
    await db.creditCard.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /:id/statements — save a statement (and its transactions), newest one updates the card's terms.
router.post('/:id/statements', async (req, res, next) => {
  try {
    const card = await ownedCard(req.params.id, req.dbUserId!);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const body = z.object({
      statement: StatementFields,
      transactions: z.array(TxnFields).max(2000).optional(),
      terms: z.record(z.any()).optional(),
      files: z.array(File).max(20).optional(),
    }).parse(req.body);
    const s = body.statement;
    const documents: { key: string; name: string }[] = [];
    for (const f of body.files ?? []) {
      const key = `${req.dbUserId}/credit-cards/${card.id}/${s.closingDate.toISOString().slice(0, 10)}_${sanitize(f.name)}`;
      await uploadDocument(key, Buffer.from(f.data, 'base64'));
      documents.push({ key, name: f.name });
    }
    const statement = await db.cardStatement.upsert({
      where: { cardId_closingDate: { cardId: card.id, closingDate: s.closingDate } },
      create: { ...(s as any), cardId: card.id, documents: documents.length ? documents : undefined },
      update: { ...(s as any), ...(documents.length ? { documents } : {}) },
    });

    // Transactions: re-importing the same statement replaces its lines rather than doubling them.
    let added = 0;
    if (body.transactions?.length) {
      await db.cardTransaction.deleteMany({ where: { statementId: statement.id, expenseId: null } });
      const kept = await db.cardTransaction.findMany({ where: { statementId: statement.id }, select: { date: true, amount: true, description: true } });
      const seen = new Set(kept.map(t => `${t.date.toISOString().slice(0, 10)}|${Number(t.amount).toFixed(2)}|${t.description}`));
      const rows = body.transactions
        .filter(t => !seen.has(`${t.date.slice(0, 10)}|${t.amount.toFixed(2)}|${t.description}`))
        .map(t => ({
          cardId: card.id, statementId: statement.id, date: new Date(t.date), postDate: t.postDate ? new Date(t.postDate) : null,
          description: t.description, merchant: t.merchant ?? null, amount: t.amount, kind: t.kind ?? (t.amount < 0 ? 'CREDIT' : 'PURCHASE'),
          category: t.category ?? null, cardholder: t.cardholder ?? null, isBusiness: card.isBusiness,
        }));
      if (rows.length) added = (await db.cardTransaction.createMany({ data: rows })).count;
    }

    // The newest statement sets the card's terms; an older one only fills blanks.
    const newest = await db.cardStatement.findFirst({ where: { cardId: card.id }, orderBy: { closingDate: 'desc' }, select: { id: true } });
    const isNewest = newest?.id === statement.id;
    const t = body.terms ?? {};
    const pick = (k: string, v: unknown) => (v == null ? {} : isNewest || (card as any)[k] == null ? { [k]: v } : {});
    const update: Record<string, unknown> = {
      ...pick('creditLimit', s.creditLimit), ...pick('purchaseApr', s.purchaseApr), ...pick('cashAdvanceApr', s.cashAdvanceApr),
      ...pick('rewardsBalance', s.rewardsBalance), ...pick('cashAdvanceLimit', t.cashAdvanceLimit), ...pick('balanceTransferApr', t.balanceTransferApr),
      ...pick('penaltyApr', t.penaltyApr), ...pick('introApr', t.introApr), ...pick('introAprType', t.introAprType),
      ...pick('introAprEndDate', t.introAprEndDate ? new Date(t.introAprEndDate) : null), ...pick('rewardsProgram', t.rewardsProgram), ...pick('rewardsType', t.rewardsType),
      ...pick('issuer', t.issuer), ...pick('network', t.network), ...pick('cardholderName', t.cardholderName),
      ...(card.last4 == null && t.last4 ? { last4: t.last4 } : {}),
      ...(isNewest ? { statementClosingDay: s.closingDate.getUTCDate(), ...(s.dueDate ? { paymentDueDay: s.dueDate.getUTCDate() } : {}) } : {}),
      ...(Array.isArray(t.authorizedUsers) && t.authorizedUsers.length && !card.authorizedUsers ? { authorizedUsers: t.authorizedUsers } : {}),
    };
    // A statement newer than the balance typed in supersedes it.
    if (isNewest && card.balanceAsOf && card.balanceAsOf < s.closingDate) { update.currentBalance = null; update.balanceAsOf = null; }
    if (Object.keys(update).length) await db.creditCard.update({ where: { id: card.id }, data: update as any });

    res.status(201).json({ statement, transactionsAdded: added });
  } catch (err) { next(err); }
});

router.delete('/statements/:sid', async (req, res, next) => {
  try {
    const s = await db.cardStatement.findFirst({ where: { id: req.params.sid, card: { userId: req.dbUserId! } } });
    if (!s) return res.status(404).json({ error: 'Not found' });
    await db.cardTransaction.deleteMany({ where: { statementId: s.id, expenseId: null } });
    await db.cardStatement.delete({ where: { id: s.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

router.get('/statements/:sid/document/:n', async (req, res, next) => {
  try {
    const s = await db.cardStatement.findFirst({ where: { id: req.params.sid, card: { userId: req.dbUserId! } } });
    const doc = ((s?.documents as any[]) ?? [])[Number(req.params.n)];
    if (!s || !doc) return res.status(404).json({ error: 'Not found' });
    res.json({ url: await getSignedDocumentUrl(doc.key), name: doc.name });
  } catch (err) { next(err); }
});

// ── Transactions ────────────────────────────────────────────────────────────
router.get('/:id/transactions', async (req, res, next) => {
  try {
    const card = await ownedCard(req.params.id, req.dbUserId!);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const { from, to, q, category, statementId, kind } = req.query as Record<string, string | undefined>;
    const rows = await db.cardTransaction.findMany({
      where: {
        cardId: card.id,
        ...(statementId ? { statementId } : {}),
        ...(category ? { category } : {}),
        ...(kind ? { kind } : {}),
        ...(from || to ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
        ...(q ? { OR: [{ description: { contains: q, mode: 'insensitive' } }, { merchant: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { date: 'desc' },
      take: 1000,
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/:id/transactions', async (req, res, next) => {
  try {
    const card = await ownedCard(req.params.id, req.dbUserId!);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const t = TxnFields.parse(req.body);
    res.status(201).json(await db.cardTransaction.create({
      data: { cardId: card.id, date: new Date(t.date), postDate: t.postDate ? new Date(t.postDate) : null, description: t.description, merchant: t.merchant ?? null,
        amount: t.amount, kind: t.kind ?? (t.amount < 0 ? 'CREDIT' : 'PURCHASE'), category: t.category ?? null, cardholder: t.cardholder ?? null, isBusiness: card.isBusiness },
    }));
  } catch (err) { next(err); }
});

router.patch('/transactions/:tid', async (req, res, next) => {
  try {
    const t = await db.cardTransaction.findFirst({ where: { id: req.params.tid, card: { userId: req.dbUserId! } } });
    if (!t) return res.status(404).json({ error: 'Not found' });
    const data = z.object({ category: z.string().nullable().optional(), isBusiness: z.boolean().optional(), propertyId: z.string().nullable().optional(), notes: z.string().nullable().optional(), merchant: z.string().nullable().optional() }).parse(req.body);
    if (data.propertyId && !(await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! }, select: { id: true } }))) return res.status(404).json({ error: 'Property not found' });
    res.json(await db.cardTransaction.update({ where: { id: t.id }, data }));
  } catch (err) { next(err); }
});

router.delete('/transactions/:tid', async (req, res, next) => {
  try {
    const t = await db.cardTransaction.findFirst({ where: { id: req.params.tid, card: { userId: req.dbUserId! } } });
    if (!t) return res.status(404).json({ error: 'Not found' });
    await db.cardTransaction.delete({ where: { id: t.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /transactions/:tid/expense — a charge that was for a property becomes that property's expense.
router.post('/transactions/:tid/expense', async (req, res, next) => {
  try {
    const t = await db.cardTransaction.findFirst({ where: { id: req.params.tid, card: { userId: req.dbUserId! } }, include: { card: { select: { name: true, last4: true } } } });
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.expenseId) return res.status(409).json({ error: 'Already recorded as an expense' });
    const body = z.object({ propertyId: z.string(), category: z.string() }).parse(req.body);
    if (!(await db.property.findFirst({ where: { id: body.propertyId, userId: req.dbUserId! }, select: { id: true } }))) return res.status(404).json({ error: 'Property not found' });
    const expense = await db.expense.create({
      data: {
        userId: req.dbUserId!, propertyId: body.propertyId, category: body.category as any, amount: Math.abs(Number(t.amount)), date: t.date,
        vendor: t.merchant ?? t.description.slice(0, 80),
        description: `${t.description} — paid with ${t.card.name}${t.card.last4 ? ` ••${t.card.last4}` : ''}`,
      },
    });
    await db.cardTransaction.update({ where: { id: t.id }, data: { expenseId: expense.id, propertyId: body.propertyId, isBusiness: true } });
    res.status(201).json(expense);
  } catch (err) { next(err); }
});

// ── Payments ────────────────────────────────────────────────────────────────
router.post('/:id/payments', async (req, res, next) => {
  try {
    const card = await ownedCard(req.params.id, req.dbUserId!);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const p = z.object({ date: z.string(), amount: z.number().positive(), fromBankAccountId: z.string().nullable().optional(), confirmation: z.string().nullable().optional(), method: z.string().nullable().optional(), notes: z.string().nullable().optional() }).parse(req.body);
    const bad = await checkRefs(req.dbUserId!, { bankAccountId: p.fromBankAccountId });
    if (bad) return res.status(404).json({ error: bad });
    const date = new Date(p.date);
    // A payment pays the newest statement that closed before it.
    const statement = await db.cardStatement.findFirst({ where: { cardId: card.id, closingDate: { lt: date } }, orderBy: { closingDate: 'desc' }, select: { id: true } });
    res.status(201).json(await db.cardPayment.create({ data: { ...p, date, cardId: card.id, statementId: statement?.id ?? null } }));
  } catch (err) { next(err); }
});

router.delete('/payments/:pid', async (req, res, next) => {
  try {
    const p = await db.cardPayment.findFirst({ where: { id: req.params.pid, card: { userId: req.dbUserId! } } });
    if (!p) return res.status(404).json({ error: 'Not found' });
    await db.cardPayment.delete({ where: { id: p.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
