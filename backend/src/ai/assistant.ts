/**
 * Ask Sollux — the assistant that can look things up across the whole app
 * and, once the owner confirms, act.
 *
 * Read tools answer from live data (bills, loans and the loan tracker, rent
 * and who is late, the pay plan, open alerts, tenants). Action tools — log a
 * rent, loan or utility payment — are never run by the model: the loop stops,
 * the owner sees exactly what will be recorded and presses Confirm, and only
 * then does /ai/agent/confirm run it, with the same ownership checks as the
 * regular API. Every id is re-checked against the owner.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';
import { PRIMARY_MODEL, FALLBACK_MODEL, paramsFor, meteredCreate, worthRetrying } from './models';
import { getPaymentPriorities } from '../services/paymentPriority';
import { trackerMonth } from '../services/loanTracker';
import { lateLeases } from './rentCollections';
import { buildPayPlan } from '../lib/payPlan';
import { recordRentPayment } from '../services/rentPaymentService';
import { syncStatementPaid } from '../routes/payments';
import { applyPaymentToPlan, applyPaymentToLoan } from '../services/planApplication';
import { downloadDocument } from '../services/s3Service';
import { fileBlockForClaude } from '../services/pdfImportService';
import { reviewInsurance } from '../services/insuranceReview';
import { opexFacts, rangeFor } from '../services/operatingExpenses';
import { buildStatement } from '../lib/opexStatement';

/** A file the owner attached in the chat: stored under their own chat folder (routes/ai.ts). */
export interface ChatAttachment { key: string; name: string }
export type ChatTurn = { role: 'user' | 'assistant'; content: string; attachments?: ChatAttachment[] };
export interface PendingAction { tool: string; input: Record<string, any>; summary: string }

const n = (v: unknown) => (v == null ? null : Number(v));
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const ym = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}$/.test(s) ? s : null);
const iso = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

const TOOLS: Anthropic.Tool[] = [
  { name: 'find', description: 'Search the portfolio by name or address: properties, tenants (with their lease ids), loans, utility accounts. Use it to get ids before other tools.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'bills_due', description: 'Utility, insurance, HOA and similar accounts with money owed now: amount, due date, past due, penalty date. Optionally for one property.', input_schema: { type: 'object', properties: { propertyId: { type: 'string' } } } },
  { name: 'account_statements', description: 'Statements on one utility / insurance / HOA / loan account, newest first (up to 36; year to filter): every figure Sollux stored — amount, past due carried, deferred to true-up, arrangement installment, fees, charge breakdown, paid state, whether a PDF is on file. Use the statementId with open_file to read the bill itself.', input_schema: { type: 'object', properties: { utilityAccountId: { type: 'string' }, year: { type: 'number' } }, required: ['utilityAccountId'] } },
  { name: 'account_detail', description: 'One account in full: provider, kind, website, billing cadence, autopay, payment plan / arrangement, linked insurance policy or loan, true-up date, last sync and its error.', input_schema: { type: 'object', properties: { utilityAccountId: { type: 'string' } }, required: ['utilityAccountId'] } },
  { name: 'payments', description: 'Payments logged on an account (or on every account of a property): date, amount, bill it went toward, method, confirmation, fees added, what came off a payment plan or loan.', input_schema: { type: 'object', properties: { utilityAccountId: { type: 'string' }, propertyId: { type: 'string' }, since: { type: 'string', description: 'YYYY-MM-DD' } } } },
  { name: 'open_file', description: "Open and read a stored file itself — the PDF of a statement (statementId), a property's tax bill (taxAssessmentId), or a scanned / uploaded document (documentId). You see the whole document: usage, line items, true-up and net-metering detail, notices. Use it whenever the question is about what a bill or document says.", input_schema: { type: 'object', properties: { statementId: { type: 'string' }, taxAssessmentId: { type: 'string' }, documentId: { type: 'string' } } } },
  { name: 'documents', description: 'Documents on file (scanned and uploaded: insurance, leases, receipts, tax, legal, HOA…), optionally for one property or category. Read one with open_file.', input_schema: { type: 'object', properties: { propertyId: { type: 'string' }, category: { type: 'string' } } } },
  { name: 'property_detail', description: 'One property in full: units, leases and tenants, loans, insurance policies, utility accounts, tax years and unpaid tax years, value and purchase.', input_schema: { type: 'object', properties: { propertyId: { type: 'string' } }, required: ['propertyId'] } },
  { name: 'taxes', description: 'Property tax: every tax year on file (installments, due and delinquency dates, paid, values, special assessments) and every unpaid / defaulted year, optionally for one property.', input_schema: { type: 'object', properties: { propertyId: { type: 'string' } } } },
  { name: 'insurance', description: 'Insurance across the portfolio: policies, coverage, yearly premiums, gaps, renewals, and claims.', input_schema: { type: 'object', properties: {} } },
  { name: 'operating_expenses', description: "A property's operating-expense statement on its saved setup: rent, each expense line, NOI, debt service and cash flow. period: last12 | ytd | lastYear.", input_schema: { type: 'object', properties: { propertyId: { type: 'string' }, period: { type: 'string', enum: ['last12', 'ytd', 'lastYear'] } }, required: ['propertyId'] } },
  { name: 'expenses', description: 'Expenses logged (repairs, landscaping, management, supplies…), optionally for one property and a date range.', input_schema: { type: 'object', properties: { propertyId: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'loan_tracker', description: "Every active loan for a month (YYYY-MM): owed, paid, due date, status (paid/partial/upcoming/due/late), how it's paid.", input_schema: { type: 'object', properties: { month: { type: 'string' } } } },
  { name: 'rent_status', description: "This month's rent: who is late past grace, how much, how many days; plus each lease's back rent.", input_schema: { type: 'object', properties: {} } },
  { name: 'pay_plan', description: 'What to pay in the next N days (default 14), which account has room for each, and how to pay.', input_schema: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'alerts', description: 'Open alerts and reminders (overdue bills, balloons, leaks, deadlines).', input_schema: { type: 'object', properties: {} } },
  { name: 'log_rent_payment', description: 'Propose logging a rent payment. The owner must confirm before it is recorded.', input_schema: { type: 'object', properties: { leaseId: { type: 'string' }, amount: { type: 'number' }, month: { type: 'string', description: 'YYYY-MM the rent is for' }, paidDate: { type: 'string', description: 'YYYY-MM-DD received' }, method: { type: 'string', enum: ['ZELLE', 'CHECK', 'CASH', 'ACH', 'BANK_DEPOSIT', 'SECTION_8', 'RENTAL_ASSISTANCE', 'VENMO', 'CASH_APP', 'PAYPAL', 'APPLE_CASH', 'MONEY_ORDER', 'CARD', 'OTHER'] }, notes: { type: 'string' } }, required: ['leaseId', 'amount', 'month', 'paidDate'] } },
  { name: 'log_loan_payment', description: 'Propose logging a loan payment. The owner must confirm before it is recorded.', input_schema: { type: 'object', properties: { loanId: { type: 'string' }, amount: { type: 'number' }, date: { type: 'string', description: 'YYYY-MM-DD paid' }, month: { type: 'string', description: 'YYYY-MM it covers' }, method: { type: 'string', enum: ['AUTOPAY', 'ONLINE', 'CHECK', 'ZELLE', 'BANK_DEPOSIT', 'CASH', 'WIRE', 'DEDUCTED', 'OTHER'] }, notes: { type: 'string' } }, required: ['loanId', 'amount', 'date'] } },
  { name: 'log_bill_payment', description: 'Propose logging a payment on a utility / insurance / HOA account, against a statement when known. The owner must confirm.', input_schema: { type: 'object', properties: { utilityAccountId: { type: 'string' }, statementId: { type: 'string' }, amount: { type: 'number' }, date: { type: 'string', description: 'YYYY-MM-DD paid' }, method: { type: 'string' }, confirmationNumber: { type: 'string' } }, required: ['utilityAccountId', 'amount', 'date'] } },
];
const ACTIONS = new Set(['log_rent_payment', 'log_loan_payment', 'log_bill_payment']);

export async function runReadTool(userId: string, name: string, input: any, today: string): Promise<unknown> {
  switch (name) {
    case 'find': {
      const q = String(input.query ?? '').trim();
      if (!q) return [];
      const c = { contains: q, mode: 'insensitive' as const };
      const [props, tenants, loans, accounts] = await Promise.all([
        db.property.findMany({ where: { userId, OR: [{ address: c }, { nickname: c }, { city: c }] }, select: { id: true, address: true, nickname: true }, take: 10 }),
        db.tenant.findMany({
          where: { fullName: c, leaseTenants: { some: { lease: { unit: { property: { userId } } } } } },
          select: { id: true, fullName: true, phone: true, email: true, leaseTenants: { select: { lease: { select: { id: true, status: true, rentAmount: true, arrearsBalance: true, unit: { select: { unitLabel: true, property: { select: { address: true, nickname: true } } } } } } } } },
          take: 10,
        }),
        db.loan.findMany({ where: { userId, OR: [{ lender: c }, { property: { address: c } }, { property: { nickname: c } }] }, select: { id: true, lender: true, isActive: true, monthlyPayment: true, escrowAmount: true, dueDay: true, currentBalance: true, maturityDate: true, property: { select: { address: true } } }, take: 10 }),
        db.utilityAccount.findMany({ where: { property: { userId }, OR: [{ providerName: c }, { serviceLabel: c }, { property: { address: c } }, { property: { nickname: c } }] }, select: { id: true, providerName: true, category: true, serviceLabel: true, property: { select: { address: true } } }, take: 15 }),
      ]);
      return {
        properties: props,
        tenants: tenants.map(t => ({ id: t.id, name: t.fullName, phone: t.phone, email: t.email, leases: t.leaseTenants.map(lt => ({ leaseId: lt.lease.id, status: lt.lease.status, rent: n(lt.lease.rentAmount), backRent: n(lt.lease.arrearsBalance), unit: lt.lease.unit.unitLabel, property: lt.lease.unit.property.nickname || lt.lease.unit.property.address })) })),
        loans: loans.map(l => ({ ...l, monthlyPayment: n(l.monthlyPayment), escrowAmount: n(l.escrowAmount), currentBalance: n(l.currentBalance), maturityDate: day(l.maturityDate) })),
        utilityAccounts: accounts,
      };
    }
    case 'bills_due': {
      const p = await getPaymentPriorities(userId, input.propertyId || undefined);
      return p.filter(x => x.balanceToCurrent > 0.01).slice(0, 40).map(x => ({ utilityAccountId: x.accountId, provider: x.providerName, service: x.serviceLabel, property: x.propertyName, owed: x.balanceToCurrent, payThisMonth: x.payThisMonth, pastDue: x.pastDue, dueDate: x.dueDate, penaltyDate: x.penaltyDate }));
    }
    case 'account_statements': {
      const y = Number(input.year) || null;
      const a = await db.utilityAccount.findFirst({
        where: { id: String(input.utilityAccountId), property: { userId } },
        select: {
          providerName: true,
          statements: {
            where: y ? { statementDate: { gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) } } : {},
            orderBy: { statementDate: 'desc' }, take: 36,
            select: {
              id: true, statementDate: true, dueDate: true, billingPeriodStart: true, billingPeriodEnd: true, amountDue: true, balance: true, amountPaid: true, paidOverride: true,
              pastDueCarried: true, trueUpDeferred: true, trueUpBalance: true, paymentPlanAmount: true, penaltiesFees: true, chargesExcludingFees: true, penaltyDate: true,
              usageValue: true, usageUnit: true, isScheduled: true, pdfS3Key: true, rawDataJson: true,
            },
          },
        },
      });
      if (!a) return { error: 'No such account' };
      return {
        provider: a.providerName,
        note: 'Owed on a bill = amountDue − deferredToTrueUp + pastDueCarried (negative = credit carried in). amountDue includes an arrangement installment when one was billed.',
        statements: a.statements.map(s => {
          const raw = (s.rawDataJson ?? {}) as Record<string, any>;
          return {
            statementId: s.id, date: day(s.statementDate), due: day(s.dueDate), period: s.billingPeriodStart ? `${day(s.billingPeriodStart)} – ${day(s.billingPeriodEnd)}` : null,
            amountDue: n(s.amountDue), pastDueCarried: n(s.pastDueCarried), deferredToTrueUp: n(s.trueUpDeferred), trueUpBalance: n(s.trueUpBalance),
            arrangementInstallment: n(s.paymentPlanAmount), fees: n(s.penaltiesFees), penaltyDate: day(s.penaltyDate), statedTotalDue: raw.statedTotalDue ?? null,
            usage: s.usageValue != null ? `${s.usageValue} ${s.usageUnit ?? ''}`.trim() : null, paid: n(s.amountPaid), markedPaid: s.paidOverride ?? null,
            scheduled: s.isScheduled, charges: raw.chargeBreakdown ?? null, alerts: raw.alerts ?? null, hasPdf: !!s.pdfS3Key,
          };
        }),
      };
    }
    case 'account_detail': {
      const a = await db.utilityAccount.findFirst({
        where: { id: String(input.utilityAccountId), property: { userId } },
        select: {
          id: true, providerName: true, category: true, serviceLabel: true, accountNumber: true, loginUrl: true, billingCadence: true, isActive: true, syncEnabled: true,
          hasTrueUp: true, trueUpDate: true, lastSyncedAt: true, lastSyncStatus: true, lastSyncError: true, escrowLoanId: true, notes: true,
          property: { select: { id: true, address: true, nickname: true } },
          paymentPlan: { select: { status: true, totalAmount: true, remainingBalance: true, monthlyAmount: true, downPayment: true, startDate: true, installmentFee: true, description: true } },
          insurancePolicy: { select: { id: true, carrier: true, policyNumber: true, policyType: true, premiumAmount: true, premiumFrequency: true, termPremium: true, effectiveDate: true, expirationDate: true } },
        },
      });
      if (!a) return { error: 'No such account' };
      // Only the last four of the account number, as everywhere else.
      return { ...a, accountNumber: a.accountNumber ? `…${String(a.accountNumber).replace(/\D/g, '').slice(-4)}` : null };
    }
    case 'payments': {
      const where: any = { utilityAccount: { property: { userId } } };
      if (input.utilityAccountId) where.utilityAccountId = String(input.utilityAccountId);
      if (input.propertyId) where.utilityAccount = { propertyId: String(input.propertyId), property: { userId } };
      if (iso(input.since)) where.paymentDate = { gte: new Date(`${input.since}T00:00:00Z`) };
      const ps = await db.payment.findMany({
        where, orderBy: { paymentDate: 'desc' }, take: 60,
        select: { id: true, paymentDate: true, amount: true, status: true, paymentMethod: true, confirmationNumber: true, notes: true, feeAmount: true, lateFeeAdded: true, feesAddedJson: true, planApplied: true, loanApplied: true, towardPlan: true,
          utilityAccount: { select: { providerName: true } }, statement: { select: { id: true, statementDate: true } } },
      });
      return ps.map(p => ({ paymentId: p.id, date: day(p.paymentDate), amount: n(p.amount), status: p.status, account: p.utilityAccount.providerName, towardBill: p.statement ? { statementId: p.statement.id, billed: day(p.statement.statementDate) } : null,
        towardArrangement: p.towardPlan, method: p.paymentMethod, confirmation: p.confirmationNumber, transactionFee: n(p.feeAmount), feesAdded: p.feesAddedJson ?? n(p.lateFeeAdded), offPlan: n(p.planApplied), offLoan: n(p.loanApplied), notes: p.notes }));
    }
    case 'open_file': {
      let key: string | null = null, name = 'file';
      if (input.statementId) {
        const st = await db.statement.findFirst({ where: { id: String(input.statementId), utilityAccount: { property: { userId } } }, select: { pdfS3Key: true, statementDate: true, utilityAccount: { select: { providerName: true } } } });
        if (!st) return { error: 'No such statement' };
        if (!st.pdfS3Key) return { error: 'No PDF is on file for that statement — only its figures.' };
        key = st.pdfS3Key; name = `${st.utilityAccount.providerName} statement ${day(st.statementDate)}`;
      } else if (input.taxAssessmentId) {
        const t = await db.taxAssessment.findFirst({ where: { id: String(input.taxAssessmentId), property: { userId } }, select: { documentS3Key: true, taxYear: true } });
        if (!t?.documentS3Key) return { error: 'No tax bill file on that record' };
        key = t.documentS3Key; name = `tax bill ${t.taxYear}`;
      } else if (input.documentId) {
        const d = await db.document.findFirst({ where: { id: String(input.documentId), userId }, select: { s3Key: true, title: true } });
        if (!d) return { error: 'No such document' };
        key = d.s3Key; name = d.title;
      } else return { error: 'Give a statementId, taxAssessmentId or documentId' };
      const buf = await downloadDocument(key);
      return { __blocks: [{ type: 'text', text: `The file: ${name}` }, await fileBlockForClaude(buf, name)] };
    }
    case 'documents': {
      const docs = await db.document.findMany({
        where: { userId, ...(input.propertyId ? { propertyId: String(input.propertyId) } : {}), ...(input.category ? { category: String(input.category) as any } : {}) },
        orderBy: { createdAt: 'desc' }, take: 60, select: { id: true, title: true, category: true, pageCount: true, createdAt: true, property: { select: { address: true, nickname: true } } },
      });
      return docs.map(d => ({ documentId: d.id, title: d.title, category: d.category, pages: d.pageCount, added: day(d.createdAt), property: d.property ? d.property.nickname || d.property.address : null }));
    }
    case 'property_detail': {
      const p = await db.property.findFirst({
        where: { id: String(input.propertyId), userId },
        select: {
          id: true, nickname: true, address: true, city: true, state: true, zip: true, county: true, apn: true, type: true, status: true, acquisitionDate: true, acquisitionPrice: true, estimatedValue: true, landValue: true, notes: true,
          units: { select: { id: true, unitLabel: true, bedrooms: true, bathrooms: true, sqft: true, leases: { where: { status: 'ACTIVE' }, select: { id: true, rentAmount: true, startDate: true, endDate: true, arrearsBalance: true, leaseTenants: { select: { tenant: { select: { fullName: true, phone: true, email: true } } } } } } } },
          loans: { select: { id: true, lender: true, loanType: true, isActive: true, currentBalance: true, interestRate: true, monthlyPayment: true, escrowAmount: true, maturityDate: true } },
          insurance: { select: { id: true, carrier: true, policyNumber: true, policyType: true, premiumAmount: true, premiumFrequency: true, termPremium: true, dwellingLimit: true, liabilityLimit: true, deductible: true, effectiveDate: true, expirationDate: true, isActive: true } },
          utilityAccounts: { select: { id: true, providerName: true, category: true, isActive: true } },
          taxAssessments: { orderBy: { taxYear: 'desc' }, take: 5, select: { id: true, taxYear: true, annualTaxAmount: true, status: true } },
          taxDefaults: { select: { id: true, taxYear: true, status: true, amountToRedeem: true } },
        },
      });
      return p ?? { error: 'No such property' };
    }
    case 'taxes': {
      const where = { property: { userId }, ...(input.propertyId ? { propertyId: String(input.propertyId) } : {}) };
      const [years, unpaid] = await Promise.all([
        db.taxAssessment.findMany({ where, orderBy: { taxYear: 'desc' }, take: 40, select: {
          id: true, propertyId: true, taxYear: true, apn: true, taxingAuthority: true, annualTaxAmount: true, status: true, installment1Amount: true, installment1Due: true, installment1Delinquent: true, installment1Paid: true,
          installment2Amount: true, installment2Due: true, installment2Delinquent: true, installment2Paid: true, assessedValue: true, landValue: true, improvementValue: true, exemptionsValue: true, baseYear: true,
          specialAssessmentsJson: true, penaltiesOwed: true, balanceOwed: true, escrowLoanId: true, documentS3Key: true, sourceUrl: true, lookedUpAt: true } }),
        db.taxDefault.findMany({ where, select: { propertyId: true, taxYear: true, status: true, defaultNumber: true, defaultDate: true, taxAmount: true, penalties: true, amountToRedeem: true, redeemGoodThrough: true, powerToSellDate: true, payPlanJson: true, certificateNumber: true, certificateHolder: true } }),
      ]);
      return { years: years.map(({ documentS3Key, ...t }) => ({ ...t, taxAssessmentId: t.id, hasBillFile: !!documentS3Key })), unpaidYears: unpaid };
    }
    case 'insurance': {
      const [review, claims] = await Promise.all([
        reviewInsurance(userId),
        db.insuranceClaim.findMany({ where: { property: { userId } }, orderBy: { createdAt: 'desc' }, take: 20 }),
      ]);
      return { ...review, claims };
    }
    case 'operating_expenses': {
      const period = (['last12', 'ytd', 'lastYear'] as const).includes(input.period) ? input.period : 'last12';
      const { facts, saved, property } = await opexFacts(String(input.propertyId), userId, rangeFor(period));
      return { property: property.name, period: rangeFor(period).label, setupSaved: !!saved.config, statement: buildStatement(facts, saved.config ?? {}) };
    }
    case 'expenses': {
      const ex = await db.expense.findMany({
        where: { property: { userId }, isPersonal: false, ...(input.propertyId ? { propertyId: String(input.propertyId) } : {}),
          ...(iso(input.from) || iso(input.to) ? { date: { ...(iso(input.from) ? { gte: new Date(`${input.from}T00:00:00Z`) } : {}), ...(iso(input.to) ? { lte: new Date(`${input.to}T23:59:59Z`) } : {}) } } : {}) },
        orderBy: { date: 'desc' }, take: 80, select: { id: true, date: true, amount: true, category: true, vendor: true, description: true, isCapEx: true, property: { select: { address: true, nickname: true } } },
      });
      return ex.map(e => ({ ...e, date: day(e.date), amount: n(e.amount), property: e.property ? e.property.nickname || e.property.address : null }));
    }
    case 'loan_tracker': {
      const t = await trackerMonth(userId, ym(input.month) ?? today.slice(0, 7), today);
      return { month: t.month, totals: t.totals, loans: t.rows.map(r => ({ loanId: r.loanId, lender: r.lender, property: r.property, owed: r.expected, paid: r.paid, remaining: r.remaining, due: r.dueDate, status: r.status, how: r.paymentMethods, instructions: r.paymentInstructions })) };
    }
    case 'rent_status': {
      const late = await lateLeases(userId);
      return late.map(l => ({ leaseId: l.leaseId, tenant: l.tenant, unit: l.unit, property: l.property, rent: l.rent, paidThisMonth: l.paid, owed: l.owed, daysLate: l.daysLate, backRent: l.arrears }));
    }
    case 'pay_plan': {
      const plan = await buildPayPlan(userId, { horizonDays: Math.min(60, Math.max(1, Number(input.days) || 14)) });
      const acct = new Map(plan.accounts.map(a => [a.id, a.name]));
      return { totals: plan.totals, payments: plan.obligations.map(o => ({ what: o.label, detail: o.detail, amount: o.amount, due: o.dueDate.slice(0, 10), status: o.status, from: o.payFrom.map(p => acct.get(p.accountId)), howToPay: o.howToPay })), warnings: plan.warnings };
    }
    case 'alerts': {
      const ins = await db.aIInsight.findMany({ where: { property: { userId }, isDismissed: false }, orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }], take: 30, select: { severity: true, title: true, body: true } });
      return ins;
    }
  }
  return { error: `Unknown tool ${name}` };
}

/** A plain sentence of what an action will record — shown on the Confirm button's card. */
async function describeAction(userId: string, tool: string, i: any): Promise<string | { error: string }> {
  const money = (v: number) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (!(Number(i.amount) > 0)) return { error: 'amount must be positive' };
  if (tool === 'log_rent_payment') {
    const l = await db.lease.findFirst({ where: { id: String(i.leaseId), unit: { property: { userId } } }, select: { unit: { select: { unitLabel: true, property: { select: { address: true } } } }, leaseTenants: { select: { tenant: { select: { fullName: true } } } } } });
    if (!l || !ym(i.month) || !iso(i.paidDate)) return { error: 'need a real leaseId, month YYYY-MM and paidDate YYYY-MM-DD' };
    return `Log ${money(i.amount)} rent from ${l.leaseTenants.map(t => t.tenant.fullName).join(', ')} (${l.unit.unitLabel}, ${l.unit.property.address}) for ${i.month}, received ${i.paidDate}${i.method ? ` by ${i.method}` : ''}.`;
  }
  if (tool === 'log_loan_payment') {
    const l = await db.loan.findFirst({ where: { id: String(i.loanId), userId }, select: { lender: true } });
    if (!l || !iso(i.date)) return { error: 'need a real loanId and date YYYY-MM-DD' };
    return `Log a ${money(i.amount)} payment to ${l.lender}, paid ${i.date}${ym(i.month) ? ` for ${i.month}` : ''}${i.method ? ` by ${i.method}` : ''}.`;
  }
  if (tool === 'log_bill_payment') {
    const a = await db.utilityAccount.findFirst({ where: { id: String(i.utilityAccountId), property: { userId } }, select: { providerName: true, property: { select: { address: true } } } });
    if (!a || !iso(i.date)) return { error: 'need a real utilityAccountId and date YYYY-MM-DD' };
    if (i.statementId && !(await db.statement.findFirst({ where: { id: String(i.statementId), utilityAccountId: String(i.utilityAccountId) }, select: { id: true } }))) return { error: 'statementId is not on that account' };
    return `Log a ${money(i.amount)} payment to ${a.providerName} (${a.property.address}), paid ${i.date}${i.statementId ? ' against that bill' : ''}.`;
  }
  return { error: 'unknown action' };
}

/** Run a confirmed action. Every id is checked against the owner again here. */
export async function runAction(userId: string, a: { tool: string; input: any }): Promise<string> {
  const desc = await describeAction(userId, a.tool, a.input);
  if (typeof desc !== 'string') throw new Error(desc.error);
  const i = a.input;
  if (a.tool === 'log_rent_payment') {
    await recordRentPayment({ leaseId: i.leaseId, periodDate: new Date(`${i.month}-01T00:00:00.000Z`), amount: Number(i.amount), paidDate: new Date(`${i.paidDate}T00:00:00.000Z`), method: (i.method ?? 'OTHER') as any, notes: i.notes || undefined });
  } else if (a.tool === 'log_loan_payment') {
    const month = ym(i.month) ?? String(i.date).slice(0, 7);
    await db.loanPayment.create({ data: { loanId: i.loanId, date: new Date(`${i.date}T00:00:00.000Z`), amount: Number(i.amount), status: 'PAID', periodDate: new Date(`${month}-01T00:00:00.000Z`), method: i.method ?? null, notes: i.notes || null } });
  } else if (a.tool === 'log_bill_payment') {
    const p = await db.payment.create({ data: { utilityAccountId: i.utilityAccountId, statementId: i.statementId || null, amount: Number(i.amount), paymentDate: new Date(`${i.date}T00:00:00.000Z`), paymentMethod: i.method || null, confirmationNumber: i.confirmationNumber || null, status: 'PAID' } });
    await syncStatementPaid(p.statementId);
    await applyPaymentToPlan(p.id);
    await applyPaymentToLoan(p.id);
  }
  return `Done — ${desc.replace(/^Log /, 'logged ')}`;
}

async function create(client: Anthropic, base: { system: string; messages: Anthropic.MessageParam[] }) {
  // Cached: each lookup turn resends the whole conversation so far.
  // Thinks before answering (comparing months of bills is analysis), and may
  // search the web — a rate rule, an installer, what a charge means.
  const tools: Anthropic.ToolUnion[] = [...TOOLS, { type: 'web_search_20260209', name: 'web_search', max_uses: 5 } as Anthropic.WebSearchTool20260209];
  const make = (model: string) => meteredCreate(client, 'assistant', { ...paramsFor(model, { maxTokens: 4000, system: base.system, messages: base.messages, cache: true, think: true }), tools } as Anthropic.MessageCreateParamsNonStreaming);
  try { return await make(PRIMARY_MODEL); }
  catch (err) {
    if (!FALLBACK_MODEL || !worthRetrying(err)) throw err;
    return make(FALLBACK_MODEL);
  }
}

/**
 * One turn of the conversation. Returns the answer, and — when the model
 * wants to record something — the actions waiting for the owner's Confirm.
 */
export async function assistantTurn(userId: string, history: ChatTurn[], today: string): Promise<{ answer: string; actions: PendingAction[] }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const system = `You are Sollux, the assistant inside a real-estate owner's property-management app (rentals, utilities, loans, taxes). Today is ${today}. You can see everything the owner has in Sollux except the vault and saved passwords: every bill and its PDF (open_file reads the document itself — usage, line items, true-up, notices), payments, payment plans, loans, rent, taxes, insurance, documents and expenses. Answer from the tools — never guess amounts, dates or ids, and never say you cannot see a bill: open it. Look things up before answering; use find to get ids. Match the question: a quick lookup gets a short answer; "why is this bill so high" or "what changed" gets a real analysis — open every relevant statement PDF (several months), compare usage (kWh, therms, gallons) and its time-of-use split, rates, credits and their balances (an SDG&E bill's net-metering summary page lists each month's net usage and the NEM credit left), charges by provider (delivery vs a CCA's generation), and fees; say what changed and when, separate what the bills prove from what they cannot show (a net-metered bill shows net grid usage, not solar production), and end with the next checks to make. Read any file or screenshot the owner attached (usage graphs, a solar app, a letter) as evidence. Search the web when outside facts help (a tariff, an installer, a program), and say where a fact came from. Ask one focused question when an answer depends on something only the owner knows.
Format with Markdown: **bold**, bullet and numbered lists, ### headings for a long answer, and tables (| a | b |). To show a chart, add a fenced block in this exact form — the app draws it:
\`\`\`chart
{"type":"bar","title":"Net grid usage by bill","unit":"kWh","labels":["May","Jun","Jul"],"series":[{"name":"Net kWh","values":[-1010,-990,-901]}]}
\`\`\`
(type "bar" or "line"; unit "$", "kWh" or any short unit; one or more series with a value per label.) Use dollar amounts and dates. To record a payment, call the matching log_* tool; it is only proposed — the owner confirms it on screen — so after proposing, say in one line what will be recorded. Do not claim anything was recorded.`;
  // Attachments travel with the turn they were sent in; the newest dozen are
  // read again on follow-ups, so "is this what you wanted?" can be answered.
  const recent = history.slice(-12);
  let budget = 12;
  const withFiles = new Set<number>();
  for (let i = recent.length - 1; i >= 0 && budget > 0; i--) if (recent[i].role === 'user' && recent[i].attachments?.length) { withFiles.add(i); budget -= recent[i].attachments!.length; }
  const messages: Anthropic.MessageParam[] = [];
  for (const [i, t] of recent.entries()) {
    if (t.role === 'user' && withFiles.has(i)) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const a of t.attachments!.slice(0, 12)) {
        try { blocks.push({ type: 'text', text: `Attached: ${a.name}` }, await fileBlockForClaude(await downloadDocument(a.key), a.name)); }
        catch (err) { blocks.push({ type: 'text', text: `Attached ${a.name}, but it could not be opened (${err instanceof Error ? err.message : err}).` }); }
      }
      blocks.push({ type: 'text', text: t.content });
      messages.push({ role: 'user', content: blocks });
    } else messages.push({ role: t.role, content: t.content });
  }
  const actions: PendingAction[] = [];

  for (let step = 0; step < 20; step++) {
    const res = await create(client, { system, messages });
    const uses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
    const text = res.content.map(c => (c.type === 'text' ? c.text : '')).join('').trim();
    // A long web search pauses the turn; it is continued as it stands.
    if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
    if (res.stop_reason !== 'tool_use' || !uses.length) return { answer: text || 'I could not find an answer to that.', actions };
    messages.push({ role: 'assistant', content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      let out: unknown;
      try {
        if (ACTIONS.has(u.name)) {
          const desc = await describeAction(userId, u.name, u.input);
          if (typeof desc === 'string') { actions.push({ tool: u.name, input: u.input as Record<string, any>, summary: desc }); out = { proposed: desc, status: 'waiting for the owner to confirm on screen' }; }
          else out = desc;
        } else out = await runReadTool(userId, u.name, u.input, today);
      } catch (err) { out = { error: err instanceof Error ? err.message : String(err) }; }
      // A file comes back as the document itself, for the model to read.
      if (out && typeof out === 'object' && '__blocks' in (out as any)) results.push({ type: 'tool_result', tool_use_id: u.id, content: (out as any).__blocks });
      else results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 40000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'That took too many steps — try asking more specifically.', actions };
}
