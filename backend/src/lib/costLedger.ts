/**
 * The cost ledger: everything a property costs, each dollar under exactly
 * one type, read from where it came from rather than guessed.
 *
 *   Utilities       bills on electric, gas, water, sewer, trash, solar, internet, phone accounts
 *   Insurance       bills on insurance accounts (premium financing included), policies with no account, logged insurance
 *   Property tax    tax-bill installments, logged tax
 *   HOA             bills on HOA accounts, logged HOA
 *   Maintenance     repairs, handyman, landscaping, supplies logged as expenses
 *   Management      property management logged as an expense
 *   Other           everything else logged
 *   Debt service    loan payments (below the operating line)
 *   Capital         improvements (kept apart from operating cost)
 *
 * Each line carries two measures by month: `charged`, in the month a bill
 * was due (what the property cost that month), and `paid`, in the month the
 * money left (payments, loan payments, tax installments paid). Nothing is
 * inferred: a paid figure is a payment on record.
 *
 * Left out, because the same money is counted elsewhere: accounts and tax
 * bills the lender pays from escrow (inside the mortgage payment), policies
 * whose bills arrive on a linked account, and loans billed like a utility
 * (their bills are that account's). Personal expenses are not a property's.
 */
import { db } from '../config/db';

import {
  typeOfAccount, typeOfExpense, monthsBetween, operatingCharge, ym, n, r2,
  type MonthFigure, type LedgerLine,
} from './costTypes';

export type { CostType, LedgerLine } from './costTypes';

export async function buildLedger(userId: string, from: string, to: string, propertyId?: string) {
  const months = monthsBetween(from, to);
  const start = new Date(`${from}-01T00:00:00.000Z`);
  const [ty, tm] = to.split('-').map(Number);
  const end = new Date(Date.UTC(ty, tm, 1));
  const inRange = (d: Date | null | undefined) => !!d && d >= start && d < end;
  // A scheduled amount (a loan payment, a policy's monthly share) is a cost
  // once its month has come; a bill or tax installment is one once it is issued.
  const thisMonth = new Date().toISOString().slice(0, 7);

  const properties = await db.property.findMany({
    where: { userId, ...(propertyId ? { id: propertyId } : {}) },
    select: { id: true, nickname: true, address: true, status: true },
    orderBy: { createdAt: 'asc' },
  });
  const ids = properties.map(p => p.id);

  const [accounts, statements, payments, expenses, loans, taxes, policies] = await Promise.all([
    db.utilityAccount.findMany({
      where: { propertyId: { in: ids }, escrowLoanId: null, isPersonal: false },
      select: { id: true, propertyId: true, providerName: true, category: true, accountNumber: true, isActive: true },
    }),
    db.statement.findMany({
      where: {
        utilityAccount: { propertyId: { in: ids }, escrowLoanId: null, isPersonal: false }, isDownPayment: false,
        OR: [{ dueDate: { gte: start, lt: end } }, { dueDate: null, statementDate: { gte: start, lt: end } }],
      },
      select: { id: true, utilityAccountId: true, statementDate: true, dueDate: true, amountDue: true, trueUpDeferred: true, paymentPlanAmount: true },
    }),
    db.payment.findMany({
      where: { utilityAccount: { propertyId: { in: ids }, escrowLoanId: null, isPersonal: false }, paymentDate: { gte: start, lt: end }, status: { notIn: ['FAILED', 'PENDING'] } },
      select: { utilityAccountId: true, amount: true, feeAmount: true, paymentDate: true },
    }),
    db.expense.findMany({
      where: { userId, propertyId: { in: ids }, isPersonal: false, date: { gte: start, lt: end } },
      select: { id: true, propertyId: true, category: true, isCapEx: true, amount: true, date: true, vendor: true, description: true },
      orderBy: { date: 'asc' },
    }),
    db.loan.findMany({
      where: { userId, propertyId: { in: ids }, isPersonal: false, utilityAccountId: null },
      select: {
        id: true, propertyId: true, lender: true, loanType: true, accountLast4: true, isActive: true, monthlyPayment: true, escrowAmount: true,
        originationDate: true, maturityDate: true,
        loanPayments: { where: { date: { gte: start, lt: end } }, select: { amount: true, date: true } },
      },
    }),
    db.taxAssessment.findMany({
      where: { propertyId: { in: ids }, escrowLoanId: null },
      select: { id: true, propertyId: true, taxYear: true, annualTaxAmount: true, installment1Due: true, installment2Due: true, installment1Paid: true, installment2Paid: true, installment1Amount: true, installment2Amount: true, taxingAuthority: true },
    }),
    db.insurancePolicy.findMany({
      where: { propertyId: { in: ids }, isPersonal: false, isActive: true, utilityAccountId: null },
      select: { id: true, propertyId: true, carrier: true, premiumAmount: true, premiumFrequency: true, effectiveDate: true, expirationDate: true },
    }),
  ]);

  const lines: LedgerLine[] = [];
  const blank = () => Object.fromEntries(months.map(m => [m, { charged: 0, paid: 0 }])) as Record<string, MonthFigure>;
  const add = (line: LedgerLine, month: string, k: keyof MonthFigure, v: number) => {
    const f = line.months[month]; if (f) f[k] = r2(f[k] + v);
  };

  // Accounts: bills charged by month due, payments by month paid.
  const byAccount = new Map<string, LedgerLine>();
  for (const a of accounts) {
    const type = typeOfAccount(a.category, a.providerName);
    if (!type) continue;
    const last4 = a.accountNumber ? String(a.accountNumber).replace(/\D/g, '').slice(-4) : '';
    const line: LedgerLine = {
      key: `account:${a.id}`, type, source: 'account', propertyId: a.propertyId, label: a.providerName,
      sub: [last4 ? `••${last4}` : null, a.isActive ? null : 'closed'].filter(Boolean).join(' · ') || null,
      link: `/properties/${a.propertyId}/utilities/${a.id}`, months: blank(),
    };
    byAccount.set(a.id, line);
  }
  for (const s of statements) {
    const line = byAccount.get(s.utilityAccountId); if (!line) continue;
    add(line, ym(s.dueDate ?? s.statementDate), 'charged', operatingCharge(s));
  }
  for (const p of payments) {
    const line = byAccount.get(p.utilityAccountId); if (!line) continue;
    add(line, ym(p.paymentDate), 'paid', n(p.amount) + n(p.feeAmount));
  }
  for (const l of byAccount.values()) if (Object.values(l.months).some(f => f.charged || f.paid)) lines.push(l);

  // Logged expenses: one line per type and vendor, each expense listed. Paid when logged.
  const byVendor = new Map<string, LedgerLine>();
  for (const e of expenses) {
    if (!e.propertyId) continue;
    const type = typeOfExpense(e.category, e.isCapEx);
    const vendor = e.vendor?.trim() || e.description?.trim() || 'Logged expense';
    const key = `expense:${e.propertyId}:${type}:${vendor.toLowerCase()}`;
    let line = byVendor.get(key);
    if (!line) {
      line = { key, type, source: 'expense', propertyId: e.propertyId, label: vendor, sub: 'Logged', link: null, months: blank(), items: [] };
      byVendor.set(key, line);
    }
    const amount = n(e.amount);
    add(line, ym(e.date), 'charged', amount);
    add(line, ym(e.date), 'paid', amount);
    line.items!.push({ date: e.date.toISOString().slice(0, 10), label: e.description || vendor, charged: amount, paid: amount, expenseId: e.id });
  }
  lines.push(...byVendor.values());

  // Loans: the scheduled payment each month it ran, and the payments made.
  for (const l of loans) {
    if (!l.propertyId) continue;
    const line: LedgerLine = {
      key: `loan:${l.id}`, type: 'DEBT_SERVICE', source: 'loan', propertyId: l.propertyId, label: l.lender,
      sub: [l.accountLast4 ? `••${l.accountLast4}` : null, l.isActive ? null : 'paid off'].filter(Boolean).join(' · ') || null,
      link: `/loans/${l.id}`, months: blank(),
    };
    const due = n(l.monthlyPayment) + n(l.escrowAmount);
    if (l.isActive && due > 0) {
      line.schedule = {};
      for (const m of months) {
        if (l.originationDate && ym(l.originationDate) > m) continue;
        if (l.maturityDate && ym(l.maturityDate) < m) continue;
        line.schedule[m] = r2(due);
        if (m <= thisMonth) add(line, m, 'charged', due);
      }
    }
    for (const p of l.loanPayments) add(line, ym(p.date), 'paid', n(p.amount));
    if (Object.values(line.months).some(f => f.charged || f.paid) || Object.keys(line.schedule ?? {}).length) lines.push(line);
  }

  // Property tax: each installment in the month it is due, and in the month it was paid.
  for (const t of taxes) {
    const line: LedgerLine = {
      key: `tax:${t.id}`, type: 'PROPERTY_TAX', source: 'tax', propertyId: t.propertyId,
      label: t.taxingAuthority || 'Property tax', sub: `Tax year ${t.taxYear}`, link: '/taxes', months: blank(),
    };
    const half = n(t.annualTaxAmount) / 2;
    const inst = [
      { due: t.installment1Due, paid: t.installment1Paid, amount: t.installment1Amount != null ? n(t.installment1Amount) : half },
      { due: t.installment2Due, paid: t.installment2Paid, amount: t.installment2Amount != null ? n(t.installment2Amount) : half },
    ];
    for (const i of inst) {
      if (inRange(i.due)) add(line, ym(i.due!), 'charged', i.amount);
      if (inRange(i.paid)) add(line, ym(i.paid!), 'paid', i.amount);
    }
    if (Object.values(line.months).some(f => f.charged || f.paid)) lines.push(line);
  }

  // A down payment entered on a policy: an insurance cost in the month it was paid,
  // unless the account already holds it as a down-payment statement.
  const downs = await db.insurancePolicy.findMany({
    // An escrowed account's policy is paid inside the mortgage payment.
    where: { propertyId: { in: ids }, isPersonal: false, downPayment: { gt: 0 }, downPaymentDate: { gte: start, lt: end }, OR: [{ utilityAccountId: null }, { utilityAccount: { escrowLoanId: null } }] },
    select: { id: true, propertyId: true, carrier: true, downPayment: true, downPaymentDate: true, utilityAccountId: true, premiumFrequency: true },
  });
  const billedDowns = downs.some(d => d.utilityAccountId) ? new Set((await db.statement.findMany({
    where: { utilityAccountId: { in: downs.map(d => d.utilityAccountId).filter((x): x is string => !!x) }, isDownPayment: true },
    select: { utilityAccountId: true },
  })).map(x => x.utilityAccountId)) : new Set<string>();
  for (const d of downs) {
    if (d.utilityAccountId && billedDowns.has(d.utilityAccountId)) continue;
    // Without a billing account, a yearly premium is the whole term, down payment included.
    if (!d.utilityAccountId && d.premiumFrequency === 'ANNUAL') continue;
    const m = ym(d.downPaymentDate!);
    const onAccount = d.utilityAccountId ? byAccount.get(d.utilityAccountId) : undefined;
    if (onAccount) {
      add(onAccount, m, 'charged', n(d.downPayment)); add(onAccount, m, 'paid', n(d.downPayment));
      if (!lines.includes(onAccount)) lines.push(onAccount);
    } else {
      const line: LedgerLine = { key: `policy-down:${d.id}`, type: 'INSURANCE', source: 'policy', propertyId: d.propertyId, label: d.carrier, sub: 'Down payment', link: '/insurance', months: blank() };
      add(line, m, 'charged', n(d.downPayment)); add(line, m, 'paid', n(d.downPayment));
      lines.push(line);
    }
  }

  // A policy with no billing account: its premium, a month's share each month it is in force.
  for (const pol of policies) {
    const monthly = pol.premiumFrequency === 'MONTHLY' ? n(pol.premiumAmount)
      : pol.premiumFrequency === 'SEMI_ANNUAL' ? n(pol.premiumAmount) / 6
      : n(pol.premiumAmount) / 12;
    if (monthly <= 0) continue;
    const line: LedgerLine = {
      key: `policy:${pol.id}`, type: 'INSURANCE', source: 'policy', propertyId: pol.propertyId, label: pol.carrier,
      sub: 'Policy premium, monthly share', link: '/insurance', months: blank(),
    };
    line.schedule = {};
    for (const m of months) {
      if (pol.effectiveDate && ym(pol.effectiveDate) > m) continue;
      if (pol.expirationDate && ym(pol.expirationDate) < m) continue;
      line.schedule[m] = r2(monthly);
      if (m <= thisMonth) add(line, m, 'charged', monthly);
    }
    if (Object.keys(line.schedule).length) lines.push(line);
  }

  return {
    months,
    properties: properties.map(p => ({ id: p.id, name: p.nickname || p.address, sold: p.status === 'SOLD' })),
    lines,
  };
}
