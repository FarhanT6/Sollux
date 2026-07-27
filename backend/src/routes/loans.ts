import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { calculateCurrentBalance, buildAmortizationSchedule } from '../lib/amortization';

const router = Router();
router.use(attachDbUser);

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
  loanType: z.enum(['MORTGAGE','HELOC','AUTO','PERSONAL','STUDENT','INSTALLMENT_PLAN','CREDIT_LINE','OTHER']),
  lender: z.string().min(1),
  accountLast4: z.string().max(4).optional().nullable(),
  originalAmount: z.number().optional().nullable(),
  interestRate: z.number().optional().nullable(),
  originationDate: z.string().transform(s => new Date(s)).optional().nullable(),
  maturityDate: z.string().transform(s => new Date(s)).optional().nullable(),
  monthlyPayment: z.number().optional().nullable(),
  currentBalance: z.number().optional().nullable(),
  paymentType: z.enum(['PRINCIPAL_AND_INTEREST', 'INTEREST_ONLY']).default('PRINCIPAL_AND_INTEREST'),
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

router.get('/', async (req, res, next) => {
  try {
    const { propertyId, isPersonal, isActive } = req.query;
    const loans = await db.loan.findMany({
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
    res.json(loans);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const loan = await db.loan.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
      include: {
        property: { select: { id: true, address: true, nickname: true } },
        loanPayments: { orderBy: { date: 'desc' } },
      },
    });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    res.json(loan);
  } catch (err) { next(err); }
});

// GET /api/loans/:id/amortization — auto-calculated balance + payoff projection
router.get('/:id/amortization', async (req, res, next) => {
  try {
    const loan = await db.loan.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
      include: { loanPayments: { orderBy: { date: 'desc' } } },
    });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });

    const loanInput = {
      originalAmount: loan.originalAmount != null ? Number(loan.originalAmount) : null,
      interestRate: loan.interestRate != null ? Number(loan.interestRate) : null,
      originationDate: loan.originationDate,
      maturityDate: loan.maturityDate,
      monthlyPayment: loan.monthlyPayment != null ? Number(loan.monthlyPayment) : null,
      currentBalance: loan.currentBalance != null ? Number(loan.currentBalance) : null,
      loanType: loan.loanType,
    };
    const paymentsInput = loan.loanPayments.map(p => ({
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

router.post('/', async (req, res, next) => {
  try {
    const data = LoanSchema.parse(req.body);
    if (data.propertyId) {
      const prop = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }
    const { propertyId, prepaymentPenaltyJson, ...rest } = data;
    const loan = await db.loan.create({
      data: {
        ...rest,
        userId: req.dbUserId!,
        prepaymentPenaltyJson: prepaymentPenaltyJson ?? Prisma.DbNull,
        ...(propertyId != null ? { property: { connect: { id: propertyId } } } : {}),
      },
    });
    res.status(201).json(loan);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { propertyId, prepaymentPenaltyJson, ...rest } = LoanSchema.partial().parse(req.body);
    const existing = await db.loan.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Loan not found' });
    const loan = await db.loan.update({
      where: { id: req.params.id },
      data: {
        ...rest,
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
    res.json(loan);
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

// Loan payments sub-resource
router.get('/:id/payments', async (req, res, next) => {
  try {
    const loan = await db.loan.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const payments = await db.loanPayment.findMany({ where: { loanId: req.params.id }, orderBy: { date: 'desc' } });
    res.json(payments);
  } catch (err) { next(err); }
});

router.post('/:id/payments', async (req, res, next) => {
  try {
    const loan = await db.loan.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const data = LoanPaymentSchema.parse(req.body);
    const payment = await db.loanPayment.create({ data: { ...data, loanId: req.params.id } });
    res.status(201).json(payment);
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
