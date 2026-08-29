import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { calculateCurrentBalance, buildAmortizationSchedule } from '../lib/amortization';
import { encryptOptional, decryptOptional } from '../crypto/encrypt';

const router = Router();
router.use(attachDbUser);

// Prisma Decimal fields serialize to JSON as strings (to preserve precision),
// which silently breaks any frontend arithmetic or currency formatting on
// them (e.g. "4256.4" + "1360.64" === "4256.41360.64" via string
// concatenation). Convert to plain numbers before they leave the API.
const DECIMAL_LOAN_FIELDS = ['originalAmount', 'interestRate', 'monthlyPayment', 'balloonPaymentAmount', 'escrowAmount', 'currentBalance', 'rateMargin'] as const;
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
  return out;
}

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

router.get('/:id', async (req, res, next) => {
  try {
    const rawLoan = await db.loan.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
      include: {
        property: { select: { id: true, address: true, nickname: true } },
        loanPayments: { orderBy: { date: 'desc' } },
        utilityAccount: { select: { id: true, providerName: true, category: true } },
        loanExtensions: { orderBy: { extendedAt: 'desc' } },
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
    const { propertyId, prepaymentPenaltyJson, accountNumber, ...rest } = data;
    if (rest.rateType === 'VARIABLE' && rest.nextRateAdjustment == null && rest.rateAdjustmentMonths) {
      rest.nextRateAdjustment = deriveDefaultNextAdjustment(rest.rateAdjustmentMonths, rest.originationDate);
    }
    const loan = await db.loan.create({
      data: {
        ...rest,
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
    const { propertyId, prepaymentPenaltyJson, accountNumber, ...rest } = LoanSchema.partial().parse(req.body);
    const existing = await db.loan.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Loan not found' });
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
    const data = LoanPaymentSchema.parse(req.body);
    const payment = await db.loanPayment.create({ data: { ...data, loanId: req.params.id } });
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
