import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { Decimal } from '@prisma/client/runtime/library';

const router = Router();
router.use(attachDbUser);

function toNum(d: Decimal | null | undefined): number {
  return d ? parseFloat(d.toString()) : 0;
}

// GET /api/budget/monthly?year=2026&month=7
// Full monthly budget summary: cash, rent, mortgages, other income, net
router.get('/monthly', async (req, res, next) => {
  try {
    const year           = parseInt((req.query.year  as string) || String(new Date().getFullYear()));
    const month          = parseInt((req.query.month as string) || String(new Date().getMonth() + 1));
    const includePersonal = req.query.includePersonal === 'true';

    const monthStart = new Date(year, month - 1, 1);
    const monthEnd   = new Date(year, month, 0, 23, 59, 59);

    const userId = req.dbUserId!;

    // ── Rent collection ──────────────────────────────────
    const activeLeases = await db.lease.findMany({
      where: {
        status: 'ACTIVE',
        unit: { property: { userId } },
      },
      include: {
        leaseTenants: { include: { tenant: true }, where: { isPrimary: true } },
        unit: { include: { property: { select: { id: true, nickname: true, address: true } } } },
        rentPayments: {
          where: { periodDate: { gte: monthStart, lte: monthEnd } },
        },
      },
    });

    const rentRows = activeLeases.map(lease => {
      const expected  = toNum(lease.rentAmount);
      const collected = lease.rentPayments.reduce((s, p) => s + toNum(p.amount), 0);
      const remaining = Math.max(0, expected - collected);
      const tenant    = lease.leaseTenants[0]?.tenant.fullName ?? 'Unknown';
      const tenantId  = lease.leaseTenants[0]?.tenant.id ?? null;
      return {
        leaseId: lease.id,
        tenant,
        tenantId,
        unit: lease.unit.unitLabel,
        property: lease.unit.property.nickname || lease.unit.property.address,
        propertyId: lease.unit.property.id,
        expected,
        collected,
        remaining,
        arrearsBalance: toNum(lease.arrearsBalance),
        status: collected === 0 ? 'unpaid' : collected >= expected ? 'paid' : 'partial',
        payments: lease.rentPayments.map(p => ({
          id: p.id,
          amount: toNum(p.amount),
          paidDate: p.paidDate,
          method: p.method,
        })),
      };
    });

    const rentExpected  = rentRows.reduce((s, r) => s + r.expected,  0);
    const rentCollected = rentRows.reduce((s, r) => s + r.collected, 0);

    // ── Mortgages ────────────────────────────────────────
    const loans = await db.loan.findMany({
      where: {
        userId,
        isActive: true,
        loanType: { in: ['MORTGAGE', 'HELOC', 'SELLER_FINANCING', 'DSCR', 'COMMERCIAL', 'HARD_MONEY'] },
      },
      include: {
        property: { select: { nickname: true, address: true } },
        loanPayments: {
          where: { date: { gte: monthStart, lte: monthEnd } },
          orderBy: { date: 'desc' },
          take: 1,
        },
      },
    });

    const mortgageRows = loans.map(loan => {
      const payment = loan.loanPayments[0];
      return {
        loanId: loan.id,
        lender: loan.lender,
        property: loan.property?.nickname || loan.property?.address || 'General',
        monthlyPayment: toNum(loan.monthlyPayment),
        paid: payment ? toNum(payment.amount) : 0,
        paidDate: payment?.date ?? null,
        status: payment ? 'paid' : 'unpaid',
      };
    });

    const mortgageTotal = mortgageRows.reduce((s, m) => s + m.monthlyPayment, 0);
    const mortgagePaid  = mortgageRows.reduce((s, m) => s + m.paid, 0);

    // ── Utility bills (statements due/issued this month) ──
    const utilityStatements = await db.statement.findMany({
      where: {
        utilityAccount: { property: { userId } },
        OR: [
          { dueDate: { gte: monthStart, lte: monthEnd } },
          { dueDate: null, statementDate: { gte: monthStart, lte: monthEnd } },
        ],
      },
      include: {
        utilityAccount: {
          select: {
            providerName: true, category: true,
            property: { select: { id: true, nickname: true, address: true } },
          },
        },
      },
      orderBy: { dueDate: 'asc' },
    });

    const utilityRows = utilityStatements.map(s => {
      const due  = toNum(s.amountDue);
      const paid = s.amountPaid != null ? toNum(s.amountPaid) : 0;
      return {
        statementId: s.id,
        provider: s.utilityAccount.providerName,
        category: s.utilityAccount.category,
        property: s.utilityAccount.property.nickname || s.utilityAccount.property.address,
        propertyId: s.utilityAccount.property.id,
        amountDue: due,
        amountPaid: paid,
        dueDate: s.dueDate,
        status: s.amountPaid != null ? 'paid' : 'unpaid',
      };
    });

    const utilitiesTotal = utilityRows.reduce((s, r) => s + r.amountDue, 0);
    const utilitiesPaid  = utilityRows.reduce((s, r) => s + r.amountPaid, 0);

    // ── Other income ─────────────────────────────────────
    const otherIncomeRows = await db.otherIncome.findMany({
      where: { userId, receivedDate: { gte: monthStart, lte: monthEnd } },
      orderBy: { receivedDate: 'desc' },
    });
    const otherIncomeTotal = otherIncomeRows.reduce((s, r) => s + toNum(r.amount), 0);

    // ── Expenses (non-mortgage) ───────────────────────────
    const expenses = await db.expense.findMany({
      where: {
        userId,
        date: { gte: monthStart, lte: monthEnd },
        ...(includePersonal ? {} : { isPersonal: false }),
      },
    });
    const expensesTotal = expenses.reduce((s, e) => s + toNum(e.amount), 0);

    // ── Bank accounts (latest balance per account) ────────
    const bankAccounts = await db.bankAccount.findMany({
      where: { userId, isActive: true },
      include: {
        balances: { orderBy: { asOfDate: 'desc' }, take: 1 },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const cashPool   = bankAccounts.filter(a => a.accountType === 'CASH_POOL');
    const bankPool   = bankAccounts.filter(a => a.accountType !== 'CASH_POOL');
    const totalBankBalance = bankPool.reduce((s, a) => s + toNum(a.balances[0]?.balance), 0);
    const totalCash        = cashPool.reduce((s, a) => s + toNum(a.balances[0]?.balance), 0);
    const totalCashOnHand  = totalBankBalance + totalCash;

    // ── Net positions ────────────────────────────────────
    const totalIncome         = rentCollected + otherIncomeTotal;
    const totalExpected       = rentExpected  + otherIncomeTotal;
    const totalExpenses       = mortgageTotal + expensesTotal + utilitiesTotal;

    const realisticNet = totalCashOnHand + rentCollected + otherIncomeTotal - mortgageTotal - expensesTotal - utilitiesTotal;
    const idealNet     = totalCashOnHand + rentExpected  + otherIncomeTotal - mortgageTotal - expensesTotal - utilitiesTotal;

    res.json({
      year,
      month,
      rent: { rows: rentRows, expected: rentExpected, collected: rentCollected, outstanding: rentExpected - rentCollected },
      mortgages: { rows: mortgageRows, total: mortgageTotal, paid: mortgagePaid, unpaid: mortgageTotal - mortgagePaid },
      utilities: { rows: utilityRows, total: utilitiesTotal, paid: utilitiesPaid, unpaid: utilitiesTotal - utilitiesPaid },
      otherIncome: { rows: otherIncomeRows, total: otherIncomeTotal },
      expenses: { total: expensesTotal },
      bankAccounts: bankAccounts.map(a => ({
        id: a.id,
        name: a.name,
        last4: a.last4,
        bank: a.bank,
        accountType: a.accountType,
        balance: toNum(a.balances[0]?.balance),
        creditLimit: toNum(a.balances[0]?.creditLimit),
        asOfDate: a.balances[0]?.asOfDate ?? null,
        notes: a.notes,
        sortOrder: a.sortOrder,
      })),
      cashSummary: {
        totalBankBalance,
        totalCash,
        totalCashOnHand,
      },
      summary: {
        totalIncome,
        totalExpected,
        totalExpenses,
        realisticNet,
        idealNet,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/budget/delinquency
// Score each tenant with arrears by likelihood of paying their past-due balance
router.get('/delinquency', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;

    const leases = await db.lease.findMany({
      where: {
        arrearsBalance: { gt: 0 },
        unit: { property: { userId } },
      },
      include: {
        leaseTenants: {
          include: { tenant: true },
          where: { isPrimary: true },
        },
        unit: { include: { property: { select: { id: true, nickname: true, address: true } } } },
        rentPayments: {
          orderBy: { paidDate: 'desc' },
          take: 12,
        },
      },
    });

    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);

    const scored = leases.map(lease => {
      const monthlyRent    = toNum(lease.rentAmount);
      const arrears        = toNum(lease.arrearsBalance);
      const payments       = lease.rentPayments;
      const lastPayment    = payments[0];
      const daysSincePay   = lastPayment
        ? Math.floor((now.getTime() - new Date(lastPayment.paidDate).getTime()) / 86400000)
        : 999;

      // Payment activity in last 6 months
      const recentPayments = payments.filter(p => new Date(p.paidDate) >= sixMonthsAgo);
      const totalRecentPaid  = recentPayments.reduce((s, p) => s + toNum(p.amount), 0);
      const monthsCovered    = Math.max(1, 6);
      const avgMonthlyPaid   = totalRecentPaid / monthsCovered;
      const paymentRatio     = monthlyRent > 0 ? avgMonthlyPaid / monthlyRent : 0;

      // Score 0-100
      let score = 50; // start neutral
      if (daysSincePay <= 14)  score += 30;
      else if (daysSincePay <= 30) score += 15;
      else if (daysSincePay <= 60) score -= 10;
      else if (daysSincePay <= 90) score -= 25;
      else score -= 40;

      if (paymentRatio >= 0.8) score += 20;
      else if (paymentRatio >= 0.5) score += 5;
      else if (paymentRatio >= 0.25) score -= 10;
      else score -= 20;

      const arrearsRatio = monthlyRent > 0 ? arrears / monthlyRent : 0;
      if (arrearsRatio > 6) score -= 20;
      else if (arrearsRatio > 3) score -= 10;
      else if (arrearsRatio < 1) score += 10;

      score = Math.max(0, Math.min(100, score));

      const computedLikelihood: 'high' | 'medium' | 'low' | 'none' =
        score >= 65 ? 'high' :
        score >= 40 ? 'medium' :
        score >= 20 ? 'low' : 'none';

      // A manual flag on the lease always wins over the automated score —
      // the landlord knows things the payment history can't capture.
      const isManualOverride = lease.manualLikelihood != null;
      const likelihood = (lease.manualLikelihood as typeof computedLikelihood) ?? computedLikelihood;

      const collectionRate = likelihood === 'high' ? 0.75 : likelihood === 'medium' ? 0.45 : likelihood === 'low' ? 0.15 : 0;
      const expectedCollection = arrears * collectionRate;

      return {
        leaseId: lease.id,
        tenant: lease.leaseTenants[0]?.tenant.fullName ?? 'Unknown',
        tenantId: lease.leaseTenants[0]?.tenant.id ?? null,
        unit: lease.unit.unitLabel,
        property: lease.unit.property.nickname || lease.unit.property.address,
        propertyId: lease.unit.property.id,
        monthlyRent,
        arrears,
        lastPaymentDate: lastPayment?.paidDate ?? null,
        lastPaymentAmount: lastPayment ? toNum(lastPayment.amount) : 0,
        daysSincePay,
        recentMonthlyAvg: avgMonthlyPaid,
        score,
        computedLikelihood,
        likelihood,
        isManualOverride,
        manualLikelihoodNote: lease.manualLikelihoodNote ?? null,
        expectedCollection,
      };
    });

    // Sort by arrears desc
    scored.sort((a, b) => b.arrears - a.arrears);

    const totalArrears   = scored.reduce((s, r) => s + r.arrears, 0);
    const totalExpected  = scored.reduce((s, r) => s + r.expectedCollection, 0);

    res.json({ tenants: scored, totalArrears, totalExpectedCollection: totalExpected });
  } catch (err) { next(err); }
});

// GET /api/budget/forecast?months=6
// Forward-looking cash flow projection from recurring baselines — active
// lease rent, active loan payments, and a trailing average of each utility
// account's bills. Not a guess at one-off income/expenses; this is meant to
// answer "if nothing changes, what does the next N months look like."
router.get('/forecast', async (req, res, next) => {
  try {
    const months = Math.min(24, Math.max(1, parseInt((req.query.months as string) || '6')));
    const userId = req.dbUserId!;
    const today = new Date();
    const horizonStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const [activeLeases, activeLoans, utilityAccounts] = await Promise.all([
      db.lease.findMany({
        where: { status: 'ACTIVE', unit: { property: { userId } } },
        select: { id: true, rentAmount: true, endDate: true, unit: { select: { property: { select: { nickname: true, address: true } } } } },
      }),
      db.loan.findMany({
        where: { userId, isActive: true, isPersonal: false },
        select: { id: true, lender: true, monthlyPayment: true, escrowAmount: true, maturityDate: true },
      }),
      db.utilityAccount.findMany({
        where: { property: { userId }, isActive: true },
        include: { statements: { orderBy: { statementDate: 'desc' }, take: 3 } },
      }),
    ]);

    // Trailing-average projected monthly cost per utility account — bills
    // fluctuate (usage, season), so a single most-recent bill would be
    // noisy; average of the last up-to-3 statements smooths that out.
    const utilityMonthlyBaseline = utilityAccounts.reduce((sum, acct) => {
      if (acct.statements.length === 0) return sum;
      const avg = acct.statements.reduce((s, st) => s + toNum(st.amountDue), 0) / acct.statements.length;
      return sum + avg;
    }, 0);

    const rentBaseline = activeLeases.reduce((s, l) => s + toNum(l.rentAmount), 0);
    const mortgageBaseline = activeLoans.reduce((s, l) => s + toNum(l.monthlyPayment) + toNum(l.escrowAmount), 0);

    const monthsOut = Array.from({ length: months }, (_, i) => {
      const monthDate = new Date(horizonStart.getFullYear(), horizonStart.getMonth() + i, 1);

      // Exclude a lease's rent once its end date has passed by that month —
      // a fixed-term lease that's known to end shouldn't be projected as
      // ongoing income past its own end date.
      const rentalIncome = activeLeases.reduce((s, l) => {
        if (l.endDate && new Date(l.endDate) < monthDate) return s;
        return s + toNum(l.rentAmount);
      }, 0);

      // Same idea for loans reaching maturity — don't project a payment
      // past the month the loan is scheduled to pay off.
      const mortgages = activeLoans.reduce((s, l) => {
        if (l.maturityDate && new Date(l.maturityDate) < monthDate) return s;
        return s + toNum(l.monthlyPayment) + toNum(l.escrowAmount);
      }, 0);

      const utilities = utilityMonthlyBaseline;
      const netCashFlow = rentalIncome - mortgages - utilities;

      return {
        month: `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`,
        label: monthDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        rentalIncome: Math.round(rentalIncome * 100) / 100,
        mortgages: Math.round(mortgages * 100) / 100,
        utilities: Math.round(utilities * 100) / 100,
        netCashFlow: Math.round(netCashFlow * 100) / 100,
      };
    });

    res.json({
      months: monthsOut,
      baseline: {
        rentBaseline: Math.round(rentBaseline * 100) / 100,
        mortgageBaseline: Math.round(mortgageBaseline * 100) / 100,
        utilityBaseline: Math.round(utilityMonthlyBaseline * 100) / 100,
        activeLeaseCount: activeLeases.length,
        activeLoanCount: activeLoans.length,
        utilityAccountsWithData: utilityAccounts.filter(a => a.statements.length > 0).length,
      },
    });
  } catch (err) { next(err); }
});

export default router;
