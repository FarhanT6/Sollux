import { db } from '../config/db';
import { Prisma } from '@prisma/client';

/**
 * The two sheets that used to be kept by hand: rent received against the
 * loans, and rent received against the loans and the utilities — per
 * property, per month, net positive or negative.
 *
 * Everything here is what happened, not what was scheduled. Rent is the
 * payments logged for the month; a month nobody logged is a month of zero
 * rent, exactly as it was on the spreadsheet. Loans are the payments logged
 * against each loan; where a month has none, the loan's scheduled payment
 * stands in and the cell says so, because a mortgage does not stop being
 * owed for want of a bookkeeping entry. Utilities are the bills for the
 * period, the same figure the P&L uses.
 */

const toNum = (d: Prisma.Decimal | number | null | undefined): number =>
  d == null ? 0 : typeof d === 'number' ? d : d.toNumber();

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export interface CashflowMonth {
  month: string;              // YYYY-MM
  rent: number;               // received, logged for this month
  rentExpected: number;       // the rent roll for the month (for context, not in the net)
  loans: number;              // paid, or scheduled where nothing logged
  loansScheduled: boolean;    // true when any loan fell back to its scheduled payment
  utilities: number;
  netAfterLoans: number;      // rent − loans
  netAfterAll: number;        // rent − loans − utilities
  detail: {
    rent: { tenant: string; unit: string; amount: number; paidDate: string }[];
    loans: { lender: string; amount: number; scheduled: boolean; date: string | null }[];
    utilities: { provider: string; amount: number; period: string | null }[];
  };
}

export interface CashflowProperty {
  propertyId: string;
  propertyName: string;
  months: CashflowMonth[];
  totals: { rent: number; rentExpected: number; loans: number; utilities: number; netAfterLoans: number; netAfterAll: number };
}

export interface CashflowReport {
  year: number;
  months: string[];           // the months covered, Jan → current month (or Dec for past years)
  byProperty: CashflowProperty[];
  totals: CashflowProperty['totals'] & { byMonth: Pick<CashflowMonth, 'month' | 'rent' | 'loans' | 'utilities' | 'netAfterLoans' | 'netAfterAll'>[] };
}

export async function getCashflow(year: number, userId: string, propertyId?: string): Promise<CashflowReport> {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
  const now = new Date();
  // A month that has not happened has no cash flow; the year is year-to-date.
  const lastMonthIdx = year < now.getUTCFullYear() ? 11 : year > now.getUTCFullYear() ? -1 : now.getUTCMonth();
  const months = Array.from({ length: lastMonthIdx + 1 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

  const propertyWhere = propertyId ? { id: propertyId, userId } : { userId };
  const properties = await db.property.findMany({
    where: propertyWhere,
    select: { id: true, address: true, nickname: true },
    orderBy: [{ state: 'asc' }, { address: 'asc' }],
  });
  const ids = properties.map(p => p.id);

  const [rentPayments, leases, loans, statements] = await Promise.all([
    db.rentPayment.findMany({
      where: { status: 'RECEIVED', periodDate: { gte: yearStart, lt: yearEnd }, lease: { unit: { propertyId: { in: ids } } } },
      select: {
        periodDate: true, amount: true, paidDate: true,
        lease: { select: { unit: { select: { propertyId: true, unitLabel: true } }, leaseTenants: { select: { tenant: { select: { fullName: true } } } } } },
      },
    }),
    db.lease.findMany({
      where: { unit: { propertyId: { in: ids } }, startDate: { lt: yearEnd }, OR: [{ status: 'ACTIVE' }, { endDate: null }, { endDate: { gt: yearStart } }] },
      select: { unitId: true, startDate: true, endDate: true, rentAmount: true, status: true, unit: { select: { propertyId: true } } },
    }),
    db.loan.findMany({
      where: { propertyId: { in: ids }, isPersonal: false },
      select: {
        id: true, propertyId: true, lender: true, monthlyPayment: true, escrowAmount: true, isActive: true, maturityDate: true, originationDate: true,
        loanPayments: { where: { date: { gte: yearStart, lt: yearEnd } }, select: { date: true, amount: true, status: true } },
      },
    }),
    db.statement.findMany({
      where: {
        amountDue: { not: null },
        isDownPayment: false,
        utilityAccount: { propertyId: { in: ids }, category: { notIn: ['INSURANCE', 'LOAN', 'CREDIT_CARD', 'TAXES'] } },
        OR: [
          { billingPeriodEnd: { gte: yearStart, lt: yearEnd } },
          { billingPeriodEnd: null, statementDate: { gte: yearStart, lt: yearEnd } },
        ],
      },
      select: {
        amountDue: true, billingPeriodStart: true, billingPeriodEnd: true, statementDate: true,
        utilityAccount: { select: { propertyId: true, providerName: true } },
      },
    }),
  ]);

  const byProperty: CashflowProperty[] = properties.map(p => {
    const rows: CashflowMonth[] = months.map(month => {
      const mStart = new Date(`${month}-01T00:00:00Z`);
      const mEnd = new Date(Date.UTC(mStart.getUTCFullYear(), mStart.getUTCMonth() + 1, 1));

      const rentRows = rentPayments
        .filter(r => r.lease.unit.propertyId === p.id && monthKey(r.periodDate) === month)
        .map(r => ({
          tenant: r.lease.leaseTenants.map(lt => lt.tenant.fullName).join(', ') || '—',
          unit: r.lease.unit.unitLabel ?? '',
          amount: toNum(r.amount),
          paidDate: r.paidDate.toISOString().slice(0, 10),
        }));
      const rent = rentRows.reduce((s, r) => s + r.amount, 0);

      // The rent roll for the month: one lease per unit, active first.
      const perUnit = new Map<string, typeof leases[number]>();
      for (const l of leases) {
        if (l.unit.propertyId !== p.id || l.status === 'PENDING' || l.startDate >= mEnd) continue;
        const inForce = l.status === 'ACTIVE' ? true : (l.endDate != null && l.endDate >= mStart);
        if (!inForce) continue;
        const cur = perUnit.get(l.unitId);
        if (!cur || (l.status === 'ACTIVE' && cur.status !== 'ACTIVE') || (l.status === cur.status && l.startDate > cur.startDate)) perUnit.set(l.unitId, l);
      }
      const rentExpected = [...perUnit.values()].reduce((s, l) => s + toNum(l.rentAmount), 0);

      const loanRows: CashflowMonth['detail']['loans'] = [];
      let loansScheduled = false;
      for (const loan of loans) {
        if (loan.propertyId !== p.id) continue;
        const paid = loan.loanPayments.filter(lp => monthKey(lp.date) === month && lp.status !== 'UNPAID');
        if (paid.length > 0) {
          for (const lp of paid) loanRows.push({ lender: loan.lender, amount: toNum(lp.amount), scheduled: false, date: lp.date.toISOString().slice(0, 10) });
          continue;
        }
        // Nothing logged: the scheduled payment stands in, for an active loan
        // that had started and not yet matured in this month.
        if (!loan.isActive) continue;
        if (loan.originationDate && loan.originationDate >= mEnd) continue;
        if (loan.maturityDate && loan.maturityDate < mStart) continue;
        const scheduled = toNum(loan.monthlyPayment) + toNum(loan.escrowAmount);
        if (scheduled <= 0) continue;
        loanRows.push({ lender: loan.lender, amount: scheduled, scheduled: true, date: null });
        loansScheduled = true;
      }
      const loansTotal = loanRows.reduce((s, r) => s + r.amount, 0);

      const utilRows = statements
        .filter(st => st.utilityAccount.propertyId === p.id && monthKey(st.billingPeriodEnd ?? st.statementDate) === month)
        .map(st => ({
          provider: st.utilityAccount.providerName,
          amount: toNum(st.amountDue),
          period: st.billingPeriodStart && st.billingPeriodEnd
            ? `${st.billingPeriodStart.toISOString().slice(0, 10)} – ${st.billingPeriodEnd.toISOString().slice(0, 10)}`
            : null,
        }));
      const utilities = utilRows.reduce((s, r) => s + r.amount, 0);

      const r2 = (n: number) => Math.round(n * 100) / 100;
      return {
        month,
        rent: r2(rent),
        rentExpected: r2(rentExpected),
        loans: r2(loansTotal),
        loansScheduled,
        utilities: r2(utilities),
        netAfterLoans: r2(rent - loansTotal),
        netAfterAll: r2(rent - loansTotal - utilities),
        detail: { rent: rentRows, loans: loanRows, utilities: utilRows },
      };
    });

    const totals = rows.reduce((t, m) => ({
      rent: t.rent + m.rent, rentExpected: t.rentExpected + m.rentExpected, loans: t.loans + m.loans, utilities: t.utilities + m.utilities,
      netAfterLoans: t.netAfterLoans + m.netAfterLoans, netAfterAll: t.netAfterAll + m.netAfterAll,
    }), { rent: 0, rentExpected: 0, loans: 0, utilities: 0, netAfterLoans: 0, netAfterAll: 0 });

    return { propertyId: p.id, propertyName: p.nickname || p.address, months: rows, totals };
  });

  const byMonth = months.map((month, i) => {
    const acc = { month, rent: 0, loans: 0, utilities: 0, netAfterLoans: 0, netAfterAll: 0 };
    for (const p of byProperty) {
      const m = p.months[i];
      acc.rent += m.rent; acc.loans += m.loans; acc.utilities += m.utilities; acc.netAfterLoans += m.netAfterLoans; acc.netAfterAll += m.netAfterAll;
    }
    return acc;
  });
  const totals = byProperty.reduce((t, p) => ({
    rent: t.rent + p.totals.rent, rentExpected: t.rentExpected + p.totals.rentExpected, loans: t.loans + p.totals.loans, utilities: t.utilities + p.totals.utilities,
    netAfterLoans: t.netAfterLoans + p.totals.netAfterLoans, netAfterAll: t.netAfterAll + p.totals.netAfterAll,
  }), { rent: 0, rentExpected: 0, loans: 0, utilities: 0, netAfterLoans: 0, netAfterAll: 0 });

  return { year, months, byProperty, totals: { ...totals, byMonth } };
}
