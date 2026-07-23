import { db } from '../config/db';
import { Prisma } from '@prisma/client';

export type DateRange = { start: Date; end: Date };

export type PropertyPnL = {
  propertyId: string;
  propertyName: string;
  rentalIncome: number;
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

export async function getPropertyPnL(propertyId: string, range: DateRange, userId: string): Promise<PropertyPnL> {
  const property = await db.property.findFirstOrThrow({ where: { id: propertyId, userId } });

  const [rentPayments, expenses, policies, taxAssessments, loans] = await Promise.all([
    db.rentPayment.findMany({
      where: { paidDate: { gte: range.start, lt: range.end }, lease: { unit: { propertyId } } },
    }),
    db.expense.findMany({
      where: { propertyId, date: { gte: range.start, lt: range.end }, isCapEx: false, isPersonal: false },
    }),
    db.insurancePolicy.findMany({ where: { propertyId, isPersonal: false, isActive: true } }),
    db.taxAssessment.findMany({ where: { propertyId } }),
    db.loan.findMany({ where: { propertyId, isPersonal: false, isActive: true }, include: { loanPayments: true } }),
  ]);

  const rentalIncome = rentPayments.reduce((s, p) => s + toNum(p.amount), 0);

  const operatingExpenses = expenses
    .filter(e => e.category !== 'INSURANCE' && e.category !== 'PROPERTY_TAX' && e.category !== 'MORTGAGE_DEBT_SERVICE' && e.category !== 'CAPITAL_IMPROVEMENT')
    .reduce((s, e) => s + toNum(e.amount), 0);

  const loggedDebtService = expenses
    .filter(e => e.category === 'MORTGAGE_DEBT_SERVICE')
    .reduce((s, e) => s + toNum(e.amount), 0);

  const looseInsurance = expenses.filter(e => e.category === 'INSURANCE').reduce((s, e) => s + toNum(e.amount), 0);
  const looseTax = expenses.filter(e => e.category === 'PROPERTY_TAX').reduce((s, e) => s + toNum(e.amount), 0);

  const insuranceExpense = looseInsurance + policies.reduce((s, pol) => {
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
    ? { loan: { propertyId } }
    : { loan: { userId } };

  const [rentPayments, expenses, policies, taxAssessments, loanPayments] = await Promise.all([
    db.rentPayment.findMany({ where: { paidDate: { gte: yearStart, lt: yearEnd }, ...leaseFilter } }),
    db.expense.findMany({ where: { date: { gte: yearStart, lt: yearEnd }, isCapEx: false, isPersonal: false, ...propertyFilter } }),
    db.insurancePolicy.findMany({ where: { isPersonal: false, isActive: true, ...propertyFilter } }),
    db.taxAssessment.findMany({ where: propertyFilter }),
    db.loanPayment.findMany({ where: { date: { gte: yearStart, lt: yearEnd }, loan: { isPersonal: false, isActive: true }, ...loanFilter } }),
  ]);

  return Array.from({ length: 12 }, (_, i) => {
    const start = new Date(Date.UTC(year, i, 1));
    const end = new Date(Date.UTC(year, i + 1, 1));
    const range: DateRange = { start, end };

    const rentalIncome = rentPayments.filter(p => p.paidDate >= start && p.paidDate < end).reduce((s, p) => s + toNum(p.amount), 0);
    const monthExpenses = expenses.filter(e => e.date >= start && e.date < end);

    const operatingExpenses = monthExpenses
      .filter(e => e.category !== 'INSURANCE' && e.category !== 'PROPERTY_TAX' && e.category !== 'MORTGAGE_DEBT_SERVICE' && e.category !== 'CAPITAL_IMPROVEMENT')
      .reduce((s, e) => s + toNum(e.amount), 0);
    const loggedDebtService = monthExpenses.filter(e => e.category === 'MORTGAGE_DEBT_SERVICE').reduce((s, e) => s + toNum(e.amount), 0);
    const looseInsurance = monthExpenses.filter(e => e.category === 'INSURANCE').reduce((s, e) => s + toNum(e.amount), 0);
    const looseTax = monthExpenses.filter(e => e.category === 'PROPERTY_TAX').reduce((s, e) => s + toNum(e.amount), 0);

    const insuranceExpense = looseInsurance + policies.reduce((s, pol) => {
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
    operatingExpenses: acc.operatingExpenses + p.operatingExpenses,
    insuranceExpense: acc.insuranceExpense + p.insuranceExpense,
    propertyTaxExpense: acc.propertyTaxExpense + p.propertyTaxExpense,
    noi: acc.noi + p.noi,
    debtService: acc.debtService + p.debtService,
    cashFlow: acc.cashFlow + p.cashFlow,
  }), { rentalIncome: 0, operatingExpenses: 0, insuranceExpense: 0, propertyTaxExpense: 0, noi: 0, debtService: 0, cashFlow: 0 });
  return { byProperty, totals };
}
