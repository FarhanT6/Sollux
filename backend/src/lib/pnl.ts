import { db } from '../config/db';
import { Prisma } from '@prisma/client';

export type DateRange = { start: Date; end: Date };

export type PropertyPnL = {
  propertyId: string;
  propertyName: string;
  /** Scheduled rent: the rent roll, pro-rated for the months each lease ran. */
  rentalIncome: number;
  /** Rent payments actually recorded in the period. */
  rentCollected: number;
  /** The rent roll for the last month in the range — what the portfolio page calls monthly rent. */
  rentRollMonthly: number;
  /** How many months of rent the rentalIncome figure covers. */
  rentMonths: number;
  operatingExpenses: number;
  insuranceExpense: number;
  propertyTaxExpense: number;
  noi: number;
  debtService: number;
  cashFlow: number;
};

export type MonthlyPnL = {
  month: string;
  label: string;
  rentalIncome: number;
  rentCollected: number;
  operatingExpenses: number;
  insuranceExpense: number;
  propertyTaxExpense: number;
  noi: number;
  debtService: number;
  cashFlow: number;
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function toNum(d: Prisma.Decimal | number | null | undefined): number {
  if (d === null || d === undefined) return 0;
  return typeof d === 'number' ? d : d.toNumber();
}

function monthsOverlap(range: DateRange, from?: Date | null, to?: Date | null): number {
  const s = from && from > range.start ? from : range.start;
  const e = to && to < range.end ? to : range.end;
  const ms = e.getTime() - s.getTime();
  if (ms <= 0) return 0;
  return ms / (1000 * 60 * 60 * 24 * 30.4375);
}


/**
 * Income is the rent roll, not the payment log. A lease is an obligation to
 * pay a known rent each month; the P&L reports that obligation for the months
 * the lease ran, the same figure the portfolio page calls monthly rent. What
 * was actually collected is reported beside it — the gap between the two is
 * arrears, and belongs in the open rather than silently shrinking income
 * whenever a payment goes unlogged.
 *
 * Two rules keep it honest. A unit is rented once per month: where an old
 * lease's paper end date overlaps its replacement, only one of them counts,
 * the active one first, so a building cannot show thirteen months of rent in
 * a year. And a month that has not happened is not income: the range stops
 * at the current month, so a year's figure is year-to-date, on the same
 * footing as the expenses beside it, which are only what has been billed.
 * An active lease past its end date is a holdover — still paying — and is
 * counted, exactly as the rent roll counts it.
 */
type LeaseLike = { unitId: string; startDate: Date; endDate: Date | null; rentAmount: Prisma.Decimal | number; status: string };

function monthsInRange(range: DateRange): number {
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const stop = range.end < lastMonth ? range.end : lastMonth;
  let n = 0;
  for (let m = new Date(Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth(), 1)); m < stop; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) n++;
  return n;
}

function scheduledRent(leases: LeaseLike[], range: DateRange): number {
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const stop = range.end < lastMonth ? range.end : lastMonth;

  let total = 0;
  for (let m = new Date(Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth(), 1)); m < stop; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const monthEnd = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    const perUnit = new Map<string, LeaseLike>();
    for (const l of leases) {
      if (l.status === 'PENDING') continue;
      if (l.startDate >= monthEnd) continue;
      const inForce = l.status === 'ACTIVE' ? true : (l.endDate != null && l.endDate >= m);
      if (!inForce) continue;
      const cur = perUnit.get(l.unitId);
      // Active beats ended; among equals the later start is the current one.
      if (!cur || (l.status === 'ACTIVE' && cur.status !== 'ACTIVE') || (l.status === cur.status && l.startDate > cur.startDate)) perUnit.set(l.unitId, l);
    }
    for (const l of perUnit.values()) total += toNum(l.rentAmount);
  }
  return total;
}

const leaseSelect = { unitId: true, startDate: true, endDate: true, rentAmount: true, status: true } as const;

/**
 * Insurance is recorded twice by design: as a UtilityAccount, which carries the
 * bills actually received, and as an InsurancePolicy, which carries coverage
 * and the agreed premium. Both are wanted — one is what happened, the other is
 * what was contracted — but only one may reach the P&L, or every insured
 * property overstates its costs by the premium.
 *
 * Statements win where they exist: a bill is what was actually charged, while
 * a premium is a plan that a mid-term endorsement or instalment fee can
 * diverge from. So a policy linked to a utility account is skipped here and
 * its cost comes from that account's statements; a policy with no linked
 * account still contributes its premium, since nothing else would report it.
 */
function isCoveredByStatements(policy: { utilityAccountId?: string | null }): boolean {
  return policy.utilityAccountId != null;
}

export async function getPropertyPnL(propertyId: string, range: DateRange, userId: string): Promise<PropertyPnL> {
  const property = await db.property.findFirstOrThrow({ where: { id: propertyId, userId } });

  const [leases, rentPayments, expenses, policies, taxAssessments, loans, utilityStatements] = await Promise.all([
    db.lease.findMany({
      where: { unit: { propertyId }, startDate: { lt: range.end }, OR: [{ status: 'ACTIVE' }, { endDate: null }, { endDate: { gt: range.start } }] },
      select: leaseSelect,
    }),
    db.rentPayment.findMany({
      where: { paidDate: { gte: range.start, lt: range.end }, lease: { unit: { propertyId } } },
    }),
    db.expense.findMany({
      where: { propertyId, date: { gte: range.start, lt: range.end }, isCapEx: false, isPersonal: false },
    }),
    db.insurancePolicy.findMany({ where: { propertyId, isPersonal: false, isActive: true } }),
    db.taxAssessment.findMany({ where: { propertyId } }),
    db.loan.findMany({ where: { propertyId, isPersonal: false, isActive: true }, include: { loanPayments: true } }),
    db.statement.findMany({
      // The account's category decides which expense line a statement belongs
      // to, and whether a linked policy's premium would double-count it.
      include: { utilityAccount: { select: { category: true, insurancePolicy: { select: { id: true } } } } },
      where: {
        amountDue: { not: null },
        utilityAccount: { propertyId },
        OR: [
          { dueDate: { gte: range.start, lt: range.end } },
          { dueDate: null, statementDate: { gte: range.start, lt: range.end } },
        ],
      },
    }),
  ]);

  const rentalIncome = scheduledRent(leases, range);
  const rentCollected = rentPayments.reduce((s, p) => s + toNum(p.amount), 0);
  const rentMonths = monthsInRange(range);
  const rollMonthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const rollMonth = { start: rollMonthStart, end: new Date(Date.UTC(rollMonthStart.getUTCFullYear(), rollMonthStart.getUTCMonth() + 1, 1)) };
  const rentRollMonthly = scheduledRent(leases, rollMonth);

  // Insurance bills are utility statements too, but they belong on the
  // insurance line, not with water and power.
  const isInsuranceStatement = (st: { utilityAccount: { category: string } }) =>
    st.utilityAccount.category === 'INSURANCE';
  const utilityExpense = utilityStatements
    .filter(st => !isInsuranceStatement(st))
    .reduce((s, st) => s + toNum(st.amountDue), 0);
  const insuranceFromStatements = utilityStatements
    .filter(isInsuranceStatement)
    .reduce((s, st) => s + toNum(st.amountDue), 0);

  const operatingExpenses = utilityExpense + expenses
    .filter(e => e.category !== 'INSURANCE' && e.category !== 'PROPERTY_TAX' && e.category !== 'MORTGAGE_DEBT_SERVICE' && e.category !== 'CAPITAL_IMPROVEMENT')
    .reduce((s, e) => s + toNum(e.amount), 0);

  const loggedDebtService = expenses
    .filter(e => e.category === 'MORTGAGE_DEBT_SERVICE')
    .reduce((s, e) => s + toNum(e.amount), 0);

  const looseInsurance = expenses.filter(e => e.category === 'INSURANCE').reduce((s, e) => s + toNum(e.amount), 0);
  const looseTax = expenses.filter(e => e.category === 'PROPERTY_TAX').reduce((s, e) => s + toNum(e.amount), 0);

  const insuranceExpense = looseInsurance + insuranceFromStatements + policies
    .filter(pol => !isCoveredByStatements(pol))
    .reduce((s, pol) => {
      const monthly = pol.premiumFrequency === 'MONTHLY' ? toNum(pol.premiumAmount)
        : pol.premiumFrequency === 'SEMI_ANNUAL' ? toNum(pol.premiumAmount) / 6
        : toNum(pol.premiumAmount) / 12;
      return s + monthly * monthsOverlap(range, pol.effectiveDate, pol.expirationDate);
    }, 0);

  const propertyTaxExpense = looseTax + taxAssessments.reduce((s, t) => {
    return s + (toNum(t.annualTaxAmount) / 12) * monthsOverlap(range);
  }, 0);

  const noi = rentalIncome - operatingExpenses - insuranceExpense - propertyTaxExpense;

  const debtService = loggedDebtService + loans.reduce((s, loan) =>
    s + loan.loanPayments
      .filter(p => p.date >= range.start && p.date < range.end)
      .reduce((ss, p) => ss + toNum(p.amount), 0), 0);

  return {
    propertyId,
    propertyName: property.nickname || property.address,
    rentalIncome,
    rentCollected,
    rentRollMonthly,
    rentMonths,
    operatingExpenses,
    insuranceExpense,
    propertyTaxExpense,
    noi,
    debtService,
    cashFlow: noi - debtService,
  };
}

export async function getMonthlyPnL(year: number, userId: string, propertyId?: string): Promise<MonthlyPnL[]> {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1));

  const propertyFilter = propertyId ? { propertyId } : { property: { userId } };
  const leaseFilter = propertyId
    ? { lease: { unit: { propertyId } } }
    : { lease: { unit: { property: { userId } } } };
  const loanFilter = propertyId
    ? { loan: { propertyId, isPersonal: false, isActive: true } }
    : { loan: { userId, isPersonal: false, isActive: true } };

  const utilityAccountFilter = propertyId ? { propertyId } : { property: { userId } };

  const leaseWhere = propertyId ? { unit: { propertyId } } : { unit: { property: { userId } } };
  const [leases, rentPayments, expenses, policies, taxAssessments, loanPayments, utilityStatements] = await Promise.all([
    db.lease.findMany({
      where: { ...leaseWhere, startDate: { lt: yearEnd }, OR: [{ status: 'ACTIVE' }, { endDate: null }, { endDate: { gt: yearStart } }] },
      select: leaseSelect,
    }),
    db.rentPayment.findMany({ where: { paidDate: { gte: yearStart, lt: yearEnd }, ...leaseFilter } }),
    db.expense.findMany({ where: { date: { gte: yearStart, lt: yearEnd }, isCapEx: false, isPersonal: false, ...propertyFilter } }),
    db.insurancePolicy.findMany({ where: { isPersonal: false, isActive: true, ...propertyFilter } }),
    db.taxAssessment.findMany({ where: propertyFilter }),
    db.loanPayment.findMany({ where: { date: { gte: yearStart, lt: yearEnd }, ...loanFilter } }),
    db.statement.findMany({
      // Same as above: the category decides which expense line this belongs on.
      include: { utilityAccount: { select: { category: true } } },
      where: {
        amountDue: { not: null },
        utilityAccount: utilityAccountFilter,
        OR: [
          { dueDate: { gte: yearStart, lt: yearEnd } },
          { dueDate: null, statementDate: { gte: yearStart, lt: yearEnd } },
        ],
      },
    }),
  ]);

  return Array.from({ length: 12 }, (_, i) => {
    const start = new Date(Date.UTC(year, i, 1));
    const end = new Date(Date.UTC(year, i + 1, 1));
    const range: DateRange = { start, end };

    const rentalIncome = scheduledRent(leases, range);
    const rentCollected = rentPayments.filter(p => p.paidDate >= start && p.paidDate < end).reduce((s, p) => s + toNum(p.amount), 0);
    const monthExpenses = expenses.filter(e => e.date >= start && e.date < end);
    const monthUtilities = utilityStatements.filter(st => {
      const d = st.dueDate ?? st.statementDate;
      return d >= start && d < end;
    });

    const monthInsuranceStatements = monthUtilities.filter(st => st.utilityAccount.category === 'INSURANCE');
    const insuranceFromStatements = monthInsuranceStatements.reduce((s, st) => s + toNum(st.amountDue), 0);
    const operatingExpenses = monthUtilities
      .filter(st => st.utilityAccount.category !== 'INSURANCE')
      .reduce((s, st) => s + toNum(st.amountDue), 0) + monthExpenses
      .filter(e => e.category !== 'INSURANCE' && e.category !== 'PROPERTY_TAX' && e.category !== 'MORTGAGE_DEBT_SERVICE' && e.category !== 'CAPITAL_IMPROVEMENT')
      .reduce((s, e) => s + toNum(e.amount), 0);
    const loggedDebtService = monthExpenses.filter(e => e.category === 'MORTGAGE_DEBT_SERVICE').reduce((s, e) => s + toNum(e.amount), 0);
    const looseInsurance = monthExpenses.filter(e => e.category === 'INSURANCE').reduce((s, e) => s + toNum(e.amount), 0);
    const looseTax = monthExpenses.filter(e => e.category === 'PROPERTY_TAX').reduce((s, e) => s + toNum(e.amount), 0);

    const insuranceExpense = looseInsurance + insuranceFromStatements + policies
      .filter(pol => !isCoveredByStatements(pol))
      .reduce((s, pol) => {
        const monthly = pol.premiumFrequency === 'MONTHLY' ? toNum(pol.premiumAmount)
          : pol.premiumFrequency === 'SEMI_ANNUAL' ? toNum(pol.premiumAmount) / 6
          : toNum(pol.premiumAmount) / 12;
        return s + monthly * monthsOverlap(range, pol.effectiveDate, pol.expirationDate);
      }, 0);

    const propertyTaxExpense = looseTax + taxAssessments.reduce((s, t) => s + (toNum(t.annualTaxAmount) / 12) * monthsOverlap(range), 0);
    const noi = rentalIncome - operatingExpenses - insuranceExpense - propertyTaxExpense;
    const debtService = loggedDebtService + loanPayments.filter(p => p.date >= start && p.date < end).reduce((s, p) => s + toNum(p.amount), 0);

    return {
      month: `${year}-${String(i + 1).padStart(2, '0')}`,
      label: MONTH_LABELS[i],
      rentalIncome,
      rentCollected,
      operatingExpenses,
      insuranceExpense,
      propertyTaxExpense,
      noi,
      debtService,
      cashFlow: noi - debtService,
    };
  });
}

export async function getPortfolioPnL(range: DateRange, userId: string) {
  const properties = await db.property.findMany({ where: { userId }, orderBy: [{ state: 'asc' }, { address: 'asc' }] });
  const byProperty = await Promise.all(properties.map(p => getPropertyPnL(p.id, range, userId)));
  const totals = byProperty.reduce((acc, p) => ({
    rentalIncome: acc.rentalIncome + p.rentalIncome,
    rentCollected: acc.rentCollected + p.rentCollected,
    rentRollMonthly: acc.rentRollMonthly + p.rentRollMonthly,
    rentMonths: Math.max(acc.rentMonths, p.rentMonths),
    operatingExpenses: acc.operatingExpenses + p.operatingExpenses,
    insuranceExpense: acc.insuranceExpense + p.insuranceExpense,
    propertyTaxExpense: acc.propertyTaxExpense + p.propertyTaxExpense,
    noi: acc.noi + p.noi,
    debtService: acc.debtService + p.debtService,
    cashFlow: acc.cashFlow + p.cashFlow,
  }), { rentalIncome: 0, rentCollected: 0, rentRollMonthly: 0, rentMonths: 0, operatingExpenses: 0, insuranceExpense: 0, propertyTaxExpense: 0, noi: 0, debtService: 0, cashFlow: 0 });
  return { byProperty, totals };
}
