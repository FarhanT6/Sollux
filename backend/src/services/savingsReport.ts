/**
 * Gathers what lib/savings.ts reads: each active account's bills by month,
 * its fees, card fees and late payments over the last year, the loans, and
 * which properties have a tenant. A handful of queries for the portfolio.
 */
import { db } from '../config/db';
import { findSavings, type AccountFacts, type LoanFacts } from '../lib/savings';

const ym = (d: Date) => d.toISOString().slice(0, 7);
const n = (v: unknown) => (v == null ? 0 : Number(v));

export async function savingsReport(userId: string) {
  const now = new Date();
  const month = ym(now);
  const yearAgo = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));
  const twoYears = new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 1));

  const [accounts, statements, payments, loans, leased] = await Promise.all([
    db.utilityAccount.findMany({
      where: { isActive: true, property: { userId, status: { not: 'SOLD' } } },
      select: { id: true, propertyId: true, providerName: true, category: true, accountNumber: true, property: { select: { nickname: true, address: true } } },
    }),
    db.statement.findMany({
      where: { utilityAccount: { isActive: true, property: { userId } }, statementDate: { gte: twoYears }, isScheduled: false, isDownPayment: false },
      select: { id: true, utilityAccountId: true, statementDate: true, dueDate: true, amountDue: true, trueUpDeferred: true, paymentPlanAmount: true, penaltiesFees: true },
    }),
    db.payment.findMany({
      where: { utilityAccount: { isActive: true, property: { userId } }, paymentDate: { gte: yearAgo }, status: { notIn: ['FAILED', 'PENDING'] } },
      select: { utilityAccountId: true, statementId: true, paymentDate: true, feeAmount: true },
    }),
    db.loan.findMany({
      where: { userId, isActive: true, isPersonal: false },
      select: { id: true, lender: true, interestRate: true, currentBalance: true, originalAmount: true, property: { select: { nickname: true, address: true } } },
    }),
    db.lease.findMany({ where: { status: 'ACTIVE', unit: { property: { userId } } }, select: { unit: { select: { propertyId: true } } } }),
  ]);

  const due = new Map(statements.map(s => [s.id, s.dueDate]));
  const facts: AccountFacts[] = accounts.map(a => {
    const mine = statements.filter(s => s.utilityAccountId === a.id);
    const charges: Record<string, number> = {};
    for (const s of mine) {
      const m = ym(s.statementDate);
      charges[m] = (charges[m] ?? 0) + n(s.amountDue) - n(s.trueUpDeferred) - n(s.paymentPlanAmount);
    }
    const paid = payments.filter(p => p.utilityAccountId === a.id);
    return {
      id: a.id, propertyId: a.propertyId, propertyName: a.property.nickname || a.property.address,
      providerName: a.providerName, category: a.category,
      last4: a.accountNumber ? String(a.accountNumber).replace(/\D/g, '').slice(-4) || null : null,
      charges,
      feesLast12: mine.filter(s => s.statementDate >= yearAgo).reduce((t, s) => t + n(s.penaltiesFees), 0),
      cardFeesLast12: paid.reduce((t, p) => t + n(p.feeAmount), 0),
      latePaid: paid.filter(p => { const d = p.statementId ? due.get(p.statementId) : null; return !!d && p.paymentDate.getTime() > d.getTime() + 86400000; }).length,
    };
  });
  const loanFacts: LoanFacts[] = loans
    .filter(l => l.interestRate != null)
    .map(l => ({ id: l.id, lender: l.lender, rate: n(l.interestRate), balance: n(l.currentBalance ?? l.originalAmount), propertyName: l.property ? l.property.nickname || l.property.address : null }));
  const occupied = new Set(leased.map(l => l.unit.propertyId));

  const savings = findSavings(facts, loanFacts, occupied, month);
  return { savings, total: savings.filter(s => s.kind !== 'HIGH_RATE_LOAN').reduce((t, s) => t + s.perYear, 0) };
}
