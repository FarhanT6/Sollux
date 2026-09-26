import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { calculateCurrentBalance, buildAmortizationSchedule } from '../lib/amortization';
import { encryptOptional, decryptOptional } from '../crypto/encrypt';
import { syncLoanFromComponents, serializeLoanComponent } from '../services/loanComponents';
import { readDocument } from '../services/documentReader';
import { trackerMonth, trackerYear } from '../services/loanTracker';
import { rowsFromCsv, matchRows, loansForMatch, applyRow, cleanRow, PAYMENT_METHODS, type SheetRow } from '../services/loanPaymentDetails';

const router = Router();
router.use(attachDbUser);

// Prisma Decimal fields serialize to JSON as strings (to preserve precision),
// which silently breaks any frontend arithmetic or currency formatting on
// them (e.g. "4256.4" + "1360.64" === "4256.41360.64" via string
// concatenation). Convert to plain numbers before they leave the API.
const DECIMAL_LOAN_FIELDS = ['originalAmount', 'downPayment', 'interestRate', 'monthlyPayment', 'balloonPaymentAmount', 'escrowAmount', 'currentBalance', 'rateMargin'] as const;
const DECIMAL_PAYMENT_FIELDS = ['billAmount', 'amount', 'lateFee', 'principal', 'interest', 'escrow', 'balanceAfter'] as const;

function serializeLoanPayment(p: any) {
  const out = { ...p };
  for (const f of DECIMAL_PAYMENT_FIELDS) if (out[f] != null) out[f] = Number(out[f]);
  return out;
}

function serializeLoan(l: any) {
  const { accountNumberEnc, ...out } = l;
  for (const f of DECIMAL_LOAN_FIELDS) if (out[f] != null) out[f] = Number(out[f]);
  if (Array.isArray(out.loanPayments)) out.loanPayments = out.loanPayments.map(serializeLoanPayment);
  if (Array.isArray(out.components)) out.components = out.components.map(serializeLoanComponent);
  return out;
}

const COMPONENTS_INCLUDE = { orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }] };

const PrepaymentTierSchema = z.object({
  startMonth: z.number().int().min(0),
  endMonth: z.number().int().min(1),
  rate: z.number().min(0).max(100),
});

const PrepaymentPenaltySchema = z.object({
  enabled: z.boolean(),
  periodMonths: z.number().int().min(1),
  tiers: z.array(PrepaymentTierSchema),
}).nullable();

const LoanSchema = z.object({
  propertyId: z.string().optional().nullable(),
  loanType: z.enum(['MORTGAGE','HELOC','AUTO','PERSONAL','STUDENT','INSTALLMENT_PLAN','CREDIT_LINE','SELLER_FINANCING','DSCR','COMMERCIAL','HARD_MONEY','OTHER']),
  lender: z.string().min(1),
  accountLast4: z.string().max(4).optional().nullable(),
  accountNumber: z.string().optional().nullable(),
  originalAmount: z.number().optional().nullable(),
  downPayment: z.number().min(0).optional().nullable(),
  interestRate: z.number().optional().nullable(),
  originationDate: z.string().transform(s => new Date(s)).optional().nullable(),
  maturityDate: z.string().transform(s => new Date(s)).optional().nullable(),
  monthlyPayment: z.number().optional().nullable(),
  balloonPaymentAmount: z.number().optional().nullable(),
  escrowAmount: z.number().optional().nullable(),
  currentBalance: z.number().optional().nullable(),
  dueDay: z.number().int().min(1).max(31).optional().nullable(),
  gracePeriodDays: z.number().int().min(0).optional().nullable(),
  paymentType: z.enum(['PRINCIPAL_AND_INTEREST', 'INTEREST_ONLY']).default('PRINCIPAL_AND_INTEREST'),
  paymentStructureChangedAt: z.string().transform(s => new Date(s)).optional().nullable(),
  rateType: z.enum(['FIXED', 'VARIABLE']).default('FIXED'),
  rateIndex: z.string().optional().nullable(),
  rateMargin: z.number().optional().nullable(),
  rateAdjustmentMonths: z.number().int().min(1).optional().nullable(),
  nextRateAdjustment: z.string().transform(s => new Date(s)).optional().nullable(),
  prepaymentPenaltyJson: PrepaymentPenaltySchema.optional(),
  notes: z.string().optional().nullable(),
  isPersonal: z.boolean().default(false),
  isActive: z.boolean().default(true),
  // The owner's account this loan is usually paid from (pay planner).
  payFromBankAccountId: z.string().optional().nullable(),
  // How the lender gets paid.
  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).optional(),
  paymentInstructions: z.string().optional().nullable(),
  mailingAddress: z.string().optional().nullable(),
  payeeBankName: z.string().optional().nullable(),
  // Last four only — anything longer is cut before it is stored.
  payeeAccountLast4: z.string().optional().nullable().transform(v => (v ? v.replace(/[^0-9A-Za-z]/g, '').slice(-4) || null : v)),
  paymentUrl: z.string().optional().nullable(),
});

const LoanPaymentSchema = z.object({
  date: z.string().transform(s => new Date(s)),
  billAmount: z.number().optional().nullable(),
  amount: z.number().positive(),
  lateFee: z.number().optional().nullable(),
  status: z.enum(['UNPAID','PAID','ON_PAYMENT_PLAN','PAST_DUE']).default('PAID'),
  principal: z.number().optional().nullable(),
  interest: z.number().optional().nullable(),
  escrow: z.number().optional().nullable(),
  balanceAfter: z.number().optional().nullable(),
  confirmationNumber: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  // The month the payment covers, YYYY-MM; defaults to the month it was paid.
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/).optional().nullable(),
  method: z.enum(PAYMENT_METHODS).optional().nullable(),
});

// Applies a due rate reset for a VARIABLE-rate loan: looks up the
// IndexRate entry that was in effect as of the loan's nextRateAdjustment
// date (not today's rate — the reset locks in whatever the index was AT
// the anniversary, same as a real ARM), applies the margin, and advances
// nextRateAdjustment forward. Loops (capped) so a loan nobody's opened in
// N years still only applies each period's *own* historical rate rather
// than jumping straight to today's.
async function recalcVariableRate(loan: any): Promise<any> {
  if (loan.rateType !== 'VARIABLE' || !loan.rateIndex || loan.rateMargin == null || !loan.rateAdjustmentMonths || !loan.nextRateAdjustment) {
    return loan;
  }
  const today = new Date();
  let nextAdjustment = new Date(loan.nextRateAdjustment);
  let currentRate: number | Prisma.Decimal = loan.interestRate;
  let changed = false;

  for (let i = 0; i < 60 && nextAdjustment <= today; i++) {
    const indexEntry = await db.indexRate.findFirst({
      where: { userId: loan.userId, indexName: loan.rateIndex, effectiveDate: { lte: nextAdjustment } },
      orderBy: { effectiveDate: 'desc' },
    });
    if (!indexEntry) break; // no rate logged yet as of that date — leave as-is rather than guess
    currentRate = Number(indexEntry.rate) + Number(loan.rateMargin);
    const advanced = new Date(nextAdjustment);
    advanced.setMonth(advanced.getMonth() + loan.rateAdjustmentMonths);
    nextAdjustment = advanced;
    changed = true;
  }

  if (!changed) return loan;
  const updated = await db.loan.update({ where: { id: loan.id }, data: { interestRate: currentRate, nextRateAdjustment: nextAdjustment } });
  return { ...loan, interestRate: updated.interestRate, nextRateAdjustment: updated.nextRateAdjustment };
}

router.get('/', async (req, res, next) => {
  try {
    const { propertyId, isPersonal, isActive } = req.query;
    const rawLoans = await db.loan.findMany({
      where: {
        userId: req.dbUserId!,
        ...(propertyId ? { propertyId: propertyId as string } : {}),
        ...(isPersonal !== undefined ? { isPersonal: isPersonal === 'true' } : {}),
        ...(isActive !== undefined ? { isActive: isActive === 'true' } : {}),
      },
      include: {
        property: { select: { id: true, address: true, nickname: true } },
        loanPayments: { orderBy: { date: 'desc' }, take: 12 },
        components: COMPONENTS_INCLUDE,
      },
      orderBy: { createdAt: 'asc' },
    });

    const loans = await Promise.all(rawLoans.map(recalcVariableRate));

    const interestAgg = await db.loanPayment.groupBy({
      by: ['loanId'],
      where: { loanId: { in: loans.map(l => l.id) } },
      _sum: { interest: true },
    });
    const interestPaidByLoan = new Map(interestAgg.map(a => [a.loanId, a._sum.interest != null ? Number(a._sum.interest) : 0]));

    const result = loans.map(l => serializeLoan({
      ...l,
      interestPaidToDate: interestPaidByLoan.get(l.id) ?? 0,
      totalInterestLifetime: computeRemainingInterest(l),
    }));

    res.json(result);
  } catch (err) { next(err); }
});

// Remaining interest from now to payoff, via the same amortization engine
// the single-loan detail page uses. Replaces an old closed-form formula
// (n = ln(PMT / (PMT - P*r)) / ln(1 + r)) that assumed standard P&I
// amortization — it returned null for interest-only/negative-am loans, and
// was numerically unstable whenever the payment landed only fractions of a
// cent above the interest-only threshold (routine when a payment was set
// via the interest-only Auto-calc, which rounds to the cent): the term
// blew up toward infinity, producing multi-million-dollar "total interest"
// for an ordinary loan. buildAmortizationSchedule is bounded — it caps
// interest-only/negative-am projections at the loan's maturity date (or a
// sane horizon), so it can't blow up the same way, and it also gives an
// answer for interest-only/negative-am loans instead of null.
function computeRemainingInterest(l: {
  originalAmount: Prisma.Decimal | null; interestRate: Prisma.Decimal | null; monthlyPayment: Prisma.Decimal | null;
  originationDate: Date | null; maturityDate: Date | null; currentBalance: Prisma.Decimal | null;
  loanType: string; paymentType: string; balloonPaymentAmount: Prisma.Decimal | null;
}): number | null {
  if (l.originalAmount == null || l.interestRate == null) return null;
  const loanInput = {
    originalAmount: Number(l.originalAmount),
    interestRate: Number(l.interestRate),
    originationDate: l.originationDate,
    maturityDate: l.maturityDate,
    monthlyPayment: l.monthlyPayment != null ? Number(l.monthlyPayment) : null,
    currentBalance: l.currentBalance != null ? Number(l.currentBalance) : null,
    loanType: l.loanType,
    paymentType: l.paymentType,
    balloonPaymentAmount: l.balloonPaymentAmount != null ? Number(l.balloonPaymentAmount) : null,
  };
  const balanceResult = calculateCurrentBalance(loanInput, []);
  if (balanceResult.balance <= 0) return null;
  const amortization = buildAmortizationSchedule(loanInput, balanceResult, []);
  return amortization.isAmortizing ? amortization.totalInterestRemaining : null;
}

// ─── Monthly payment tracker ───────────────────────────────
// GET /api/loans/tracker?month=YYYY-MM&today=YYYY-MM-DD, or ?year=YYYY for
// twelve months side by side. `today` is the viewer's date, so "late" turns
// on at their midnight, not the server's.
router.get('/tracker', async (req, res, next) => {
  try {
    const q = z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      year: z.coerce.number().int().min(2000).max(2100).optional(),
      today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.query);
    const today = q.today ?? new Date().toISOString().slice(0, 10);
    if (q.year) return res.json(await trackerYear(req.dbUserId!, q.year, today));
    res.json(await trackerMonth(req.dbUserId!, q.month ?? today.slice(0, 7), today));
  } catch (err) { next(err); }
});

// ─── Payment details from the owner's loan sheet ───────────
// Read a sheet (CSV exactly; PDF or photo through Claude), pair each row with
// an existing loan, and let the owner confirm before anything is written.
// Rows never create or delete loans.
const FileSchema = z.object({ name: z.string(), data: z.string() });

router.post('/payment-details/read', async (req, res, next) => {
  try {
    const { files } = z.object({ files: z.array(FileSchema).min(1).max(12) }).parse(req.body);
    let rows: SheetRow[] = [];
    const docs = [];
    for (const f of files) {
      const buf = Buffer.from(f.data, 'base64');
      if (/\.csv$/i.test(f.name) || (!buf.includes('%PDF-') && /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(buf.subarray(0, 2000).toString('utf8')) && buf.subarray(0, 2000).toString('utf8').includes(','))) {
        rows.push(...rowsFromCsv(buf.toString('utf8')));
      } else docs.push(f);
    }
    if (docs.length) {
      const { fields } = await readDocument('loan_sheet', docs, req.dbUserId!);
      rows.push(...(fields.loans as SheetRow[]));
    }
    if (!rows.length) return res.status(422).json({ error: 'No loan rows were found in the sheet.' });
    const loans = await loansForMatch(req.dbUserId!);
    const matches = matchRows(rows, loans);
    res.json({
      rows: rows.map((row, i) => ({ row, loanId: matches[i] })),
      loans: loans.map(l => ({ id: l.id, lender: l.lender, property: l.propertyNickname || l.propertyAddress, monthlyPayment: l.monthlyPayment, accountLast4: l.accountLast4 })),
    });
  } catch (err) { next(err); }
});

router.post('/payment-details/apply', async (req, res, next) => {
  try {
    const { items } = z.object({ items: z.array(z.object({ loanId: z.string(), row: z.record(z.unknown()) })).max(200) }).parse(req.body);
    const seen = new Set<string>();
    let updated = 0;
    for (const it of items) {
      if (seen.has(it.loanId)) return res.status(400).json({ error: 'Two rows point at the same loan — pick one.' });
      seen.add(it.loanId);
      // The confirmed row is cleaned again server-side; nothing is trusted as sent.
      const row = cleanRow({ ...it.row, paymentMethod: (it.row as any).paymentInstructions, payeeAccount: (it.row as any).payeeAccountLast4 });
      if (row && (await applyRow(req.dbUserId!, it.loanId, row))) updated++;
    }
    res.json({ updated });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const rawLoan = await db.loan.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
      include: {
        property: { select: { id: true, address: true, nickname: true } },
        loanPayments: { orderBy: { date: 'desc' } },
        utilityAccount: { select: { id: true, providerName: true, category: true } },
        loanExtensions: { orderBy: { extendedAt: 'desc' } },
        components: COMPONENTS_INCLUDE,
      },
    });
    if (!rawLoan) return res.status(404).json({ error: 'Loan not found' });
    const loan = await recalcVariableRate(rawLoan);
    res.json({ ...serializeLoan(loan), accountNumber: decryptOptional(loan.accountNumberEnc) });
  } catch (err) { next(err); }
});

// GET /api/loans/:id/amortization — auto-calculated balance + payoff projection
router.get('/:id/amortization', async (req, res, next) => {
  try {
    const rawLoan = await db.loan.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
      include: { loanPayments: { orderBy: { date: 'desc' } } },
    });
    if (!rawLoan) return res.status(404).json({ error: 'Loan not found' });
    const loan = await recalcVariableRate(rawLoan);

    const loanInput = {
      originalAmount: loan.originalAmount != null ? Number(loan.originalAmount) : null,
      interestRate: loan.interestRate != null ? Number(loan.interestRate) : null,
      originationDate: loan.originationDate,
      maturityDate: loan.maturityDate,
      monthlyPayment: loan.monthlyPayment != null ? Number(loan.monthlyPayment) : null,
      currentBalance: loan.currentBalance != null ? Number(loan.currentBalance) : null,
      loanType: loan.loanType,
      paymentType: loan.paymentType,
      balloonPaymentAmount: loan.balloonPaymentAmount != null ? Number(loan.balloonPaymentAmount) : null,
    };
    const paymentsInput = loan.loanPayments.map((p: any) => ({
      date: p.date,
      amount: Number(p.amount),
      principal: p.principal != null ? Number(p.principal) : null,
      interest: p.interest != null ? Number(p.interest) : null,
      balanceAfter: p.balanceAfter != null ? Number(p.balanceAfter) : null,
    }));

    const balanceResult = calculateCurrentBalance(loanInput, paymentsInput);
    const amortization = buildAmortizationSchedule(loanInput, balanceResult, paymentsInput);

    res.json({ balance: balanceResult, amortization });
  } catch (err) { next(err); }
});

// A newly-set-to-VARIABLE loan needs an initial nextRateAdjustment to
// anchor its reset cycle to, if the caller didn't provide one explicitly —
// anchor to the loan's origination date (its natural anniversary), or
// today if there's no origination date on file.
function deriveDefaultNextAdjustment(rateAdjustmentMonths: number, originationDate: Date | null | undefined): Date {
  const anchor = originationDate ? new Date(originationDate) : new Date();
  anchor.setMonth(anchor.getMonth() + rateAdjustmentMonths);
  return anchor;
}

router.post('/', async (req, res, next) => {
  try {
    const data = LoanSchema.parse(req.body);
    if (data.propertyId) {
      const prop = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }
    const { propertyId, prepaymentPenaltyJson, accountNumber, payFromBankAccountId, ...rest } = data;
    if (rest.rateType === 'VARIABLE' && rest.nextRateAdjustment == null && rest.rateAdjustmentMonths) {
      rest.nextRateAdjustment = deriveDefaultNextAdjustment(rest.rateAdjustmentMonths, rest.originationDate);
    }
    if (payFromBankAccountId) {
      const acct = await db.bankAccount.findFirst({ where: { id: payFromBankAccountId, userId: req.dbUserId! } });
      if (!acct) return res.status(404).json({ error: 'Bank account not found' });
    }
    const loan = await db.loan.create({
      data: {
        ...rest,
        ...(payFromBankAccountId ? { payFromBankAccount: { connect: { id: payFromBankAccountId } } } : {}),
        ...(accountNumber
          ? { accountNumberEnc: encryptOptional(accountNumber), accountLast4: accountNumber.slice(-4) }
          : {}),
        userId: req.dbUserId!,
        prepaymentPenaltyJson: prepaymentPenaltyJson ?? Prisma.DbNull,
        ...(propertyId != null ? { property: { connect: { id: propertyId } } } : {}),
      },
    });
    res.status(201).json(serializeLoan(loan));
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { propertyId, prepaymentPenaltyJson, accountNumber, payFromBankAccountId, ...rest } = LoanSchema.partial().parse(req.body);
    const existing = await db.loan.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Loan not found' });
    if (payFromBankAccountId) {
      const acct = await db.bankAccount.findFirst({ where: { id: payFromBankAccountId, userId: req.dbUserId! } });
      if (!acct) return res.status(404).json({ error: 'Bank account not found' });
    }
    const effectiveRateType = rest.rateType ?? existing.rateType;
    const effectiveAdjustmentMonths = rest.rateAdjustmentMonths ?? existing.rateAdjustmentMonths;
    if (effectiveRateType === 'VARIABLE' && rest.nextRateAdjustment === undefined && existing.nextRateAdjustment == null && effectiveAdjustmentMonths) {
      rest.nextRateAdjustment = deriveDefaultNextAdjustment(effectiveAdjustmentMonths, rest.originationDate ?? existing.originationDate);
    }
    const loan = await db.loan.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        ...(accountNumber !== undefined
          ? {
              accountNumberEnc: encryptOptional(accountNumber),
              accountLast4: accountNumber ? accountNumber.slice(-4) : null,
            }
          : {}),
        ...(prepaymentPenaltyJson !== undefined
          ? { prepaymentPenaltyJson: prepaymentPenaltyJson ?? Prisma.DbNull }
          : {}),
        ...(propertyId !== undefined
          ? propertyId != null
            ? { property: { connect: { id: propertyId } } }
            : { property: { disconnect: true } }
          : {}),
        ...(payFromBankAccountId !== undefined
          ? payFromBankAccountId
            ? { payFromBankAccount: { connect: { id: payFromBankAccountId } } }
            : { payFromBankAccount: { disconnect: true } }
          : {}),
      },
    });
    res.json(serializeLoan(loan));
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.loan.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Loan not found' });
    await db.loan.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── Loans within the account ─────────────────────────────────────────────────
// A student-loan servicer bills several loans on one statement. Each is a
// component; the parent loan's figures are recomputed from them on every
// change (services/loanComponents.ts).

const LoanComponentSchema = z.object({
  label: z.string().min(1),
  loanKind: z.string().optional().nullable(),
  originalAmount: z.number().min(0).optional().nullable(),
  currentBalance: z.number().min(0).optional().nullable(),
  interestRate: z.number().min(0).optional().nullable(),
  monthlyPayment: z.number().min(0).optional().nullable(),
  accruedInterest: z.number().min(0).optional().nullable(),
  originationDate: z.string().transform(s => new Date(s)).optional().nullable(),
  maturityDate: z.string().transform(s => new Date(s)).optional().nullable(),
  notes: z.string().optional().nullable(),
  sortOrder: z.number().int().optional(),
});

async function ownedLoan(id: string, userId: string) {
  return db.loan.findFirst({ where: { id, userId }, select: { id: true } });
}

async function loanWithComponents(id: string) {
  const loan = await db.loan.findUnique({ where: { id }, include: { components: COMPONENTS_INCLUDE } });
  return loan ? serializeLoan(loan) : null;
}

router.get('/:id/components', async (req, res, next) => {
  try {
    if (!await ownedLoan(req.params.id, req.dbUserId!)) return res.status(404).json({ error: 'Loan not found' });
    const parts = await db.loanComponent.findMany({ where: { loanId: req.params.id }, ...COMPONENTS_INCLUDE });
    res.json(parts.map(serializeLoanComponent));
  } catch (err) { next(err); }
});

// Returns the parent loan with its components and refreshed totals, so the
// caller can replace what it holds in one go.
router.post('/:id/components', async (req, res, next) => {
  try {
    if (!await ownedLoan(req.params.id, req.dbUserId!)) return res.status(404).json({ error: 'Loan not found' });
    const data = LoanComponentSchema.parse(req.body);
    const count = await db.loanComponent.count({ where: { loanId: req.params.id } });
    await db.loanComponent.create({ data: { ...data, sortOrder: data.sortOrder ?? count, loanId: req.params.id } });
    await syncLoanFromComponents(req.params.id);
    res.status(201).json(await loanWithComponents(req.params.id));
  } catch (err) { next(err); }
});

router.patch('/:id/components/:cid', async (req, res, next) => {
  try {
    if (!await ownedLoan(req.params.id, req.dbUserId!)) return res.status(404).json({ error: 'Loan not found' });
    const data = LoanComponentSchema.partial().parse(req.body);
    const existing = await db.loanComponent.findFirst({ where: { id: req.params.cid, loanId: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Loan component not found' });
    await db.loanComponent.update({ where: { id: existing.id }, data });
    await syncLoanFromComponents(req.params.id);
    res.json(await loanWithComponents(req.params.id));
  } catch (err) { next(err); }
});

router.delete('/:id/components/:cid', async (req, res, next) => {
  try {
    if (!await ownedLoan(req.params.id, req.dbUserId!)) return res.status(404).json({ error: 'Loan not found' });
    const existing = await db.loanComponent.findFirst({ where: { id: req.params.cid, loanId: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Loan component not found' });
    await db.loanComponent.delete({ where: { id: existing.id } });
    await syncLoanFromComponents(req.params.id);
    res.json(await loanWithComponents(req.params.id));
  } catch (err) { next(err); }
});

const ExtendLoanSchema = z.object({
  months: z.number().int().positive(),
  notes: z.string().optional().nullable(),
});

// POST /api/loans/:id/extend — exercise a maturity-date extension (e.g. a
// lender-granted option to push the balloon out further). Records an audit
// row and moves maturityDate forward from whatever it currently is.
router.post('/:id/extend', async (req, res, next) => {
  try {
    const { months, notes } = ExtendLoanSchema.parse(req.body);
    const existing = await db.loan.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Loan not found' });
    if (!existing.maturityDate) {
      return res.status(400).json({ error: 'This loan has no maturity date on file to extend from — set one first.' });
    }

    const previousMaturityDate = existing.maturityDate;
    const newMaturityDate = new Date(previousMaturityDate);
    newMaturityDate.setMonth(newMaturityDate.getMonth() + months);

    const [loan] = await db.$transaction([
      db.loan.update({ where: { id: req.params.id }, data: { maturityDate: newMaturityDate } }),
      db.loanExtension.create({
        data: { loanId: req.params.id, months, previousMaturityDate, newMaturityDate, notes: notes || null },
      }),
    ]);

    res.json(serializeLoan(loan));
  } catch (err) { next(err); }
});

// Loan payments sub-resource
router.get('/:id/payments', async (req, res, next) => {
  try {
    const loan = await db.loan.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const payments = await db.loanPayment.findMany({ where: { loanId: req.params.id }, orderBy: { date: 'desc' } });
    res.json(payments.map(serializeLoanPayment));
  } catch (err) { next(err); }
});

router.post('/:id/payments', async (req, res, next) => {
  try {
    const loan = await db.loan.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const { periodMonth, ...data } = LoanPaymentSchema.parse(req.body);
    const payment = await db.loanPayment.create({
      data: { ...data, loanId: req.params.id, ...(periodMonth ? { periodDate: new Date(`${periodMonth}-01T00:00:00.000Z`) } : {}) },
    });
    res.status(201).json(serializeLoanPayment(payment));
  } catch (err) { next(err); }
});

router.delete('/:id/payments/:paymentId', async (req, res, next) => {
  try {
    const loan = await db.loan.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    await db.loanPayment.delete({ where: { id: req.params.paymentId } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
