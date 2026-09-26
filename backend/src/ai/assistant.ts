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
import { PRIMARY_MODEL, FALLBACK_MODEL, paramsFor, worthRetrying } from './models';
import { getPaymentPriorities } from '../services/paymentPriority';
import { trackerMonth } from '../services/loanTracker';
import { lateLeases } from './rentCollections';
import { buildPayPlan } from '../lib/payPlan';
import { recordRentPayment } from '../services/rentPaymentService';
import { syncStatementPaid } from '../routes/payments';
import { applyPaymentToPlan, applyPaymentToLoan } from '../services/planApplication';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };
export interface PendingAction { tool: string; input: Record<string, any>; summary: string }

const n = (v: unknown) => (v == null ? null : Number(v));
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const ym = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}$/.test(s) ? s : null);
const iso = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

const TOOLS: Anthropic.Tool[] = [
  { name: 'find', description: 'Search the portfolio by name or address: properties, tenants (with their lease ids), loans, utility accounts. Use it to get ids before other tools.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'bills_due', description: 'Utility, insurance, HOA and similar accounts with money owed now: amount, due date, past due, penalty date. Optionally for one property.', input_schema: { type: 'object', properties: { propertyId: { type: 'string' } } } },
  { name: 'account_statements', description: 'Recent statements on one utility account: dates, amount, paid.', input_schema: { type: 'object', properties: { utilityAccountId: { type: 'string' } }, required: ['utilityAccountId'] } },
  { name: 'loan_tracker', description: "Every active loan for a month (YYYY-MM): owed, paid, due date, status (paid/partial/upcoming/due/late), how it's paid.", input_schema: { type: 'object', properties: { month: { type: 'string' } } } },
  { name: 'rent_status', description: "This month's rent: who is late past grace, how much, how many days; plus each lease's back rent.", input_schema: { type: 'object', properties: {} } },
  { name: 'pay_plan', description: 'What to pay in the next N days (default 14), which account has room for each, and how to pay.', input_schema: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'alerts', description: 'Open alerts and reminders (overdue bills, balloons, leaks, deadlines).', input_schema: { type: 'object', properties: {} } },
  { name: 'log_rent_payment', description: 'Propose logging a rent payment. The owner must confirm before it is recorded.', input_schema: { type: 'object', properties: { leaseId: { type: 'string' }, amount: { type: 'number' }, month: { type: 'string', description: 'YYYY-MM the rent is for' }, paidDate: { type: 'string', description: 'YYYY-MM-DD received' }, method: { type: 'string', enum: ['ZELLE', 'CHECK', 'CASH', 'ACH', 'BANK_DEPOSIT', 'SECTION_8', 'RENTAL_ASSISTANCE', 'VENMO', 'CASH_APP', 'PAYPAL', 'APPLE_CASH', 'MONEY_ORDER', 'CARD', 'OTHER'] }, notes: { type: 'string' } }, required: ['leaseId', 'amount', 'month', 'paidDate'] } },
  { name: 'log_loan_payment', description: 'Propose logging a loan payment. The owner must confirm before it is recorded.', input_schema: { type: 'object', properties: { loanId: { type: 'string' }, amount: { type: 'number' }, date: { type: 'string', description: 'YYYY-MM-DD paid' }, month: { type: 'string', description: 'YYYY-MM it covers' }, method: { type: 'string', enum: ['AUTOPAY', 'ONLINE', 'CHECK', 'ZELLE', 'BANK_DEPOSIT', 'CASH', 'WIRE', 'DEDUCTED', 'OTHER'] }, notes: { type: 'string' } }, required: ['loanId', 'amount', 'date'] } },
  { name: 'log_bill_payment', description: 'Propose logging a payment on a utility / insurance / HOA account, against a statement when known. The owner must confirm.', input_schema: { type: 'object', properties: { utilityAccountId: { type: 'string' }, statementId: { type: 'string' }, amount: { type: 'number' }, date: { type: 'string', description: 'YYYY-MM-DD paid' }, method: { type: 'string' }, confirmationNumber: { type: 'string' } }, required: ['utilityAccountId', 'amount', 'date'] } },
];
const ACTIONS = new Set(['log_rent_payment', 'log_loan_payment', 'log_bill_payment']);

async function runReadTool(userId: string, name: string, input: any, today: string): Promise<unknown> {
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
      const a = await db.utilityAccount.findFirst({ where: { id: String(input.utilityAccountId), property: { userId } }, select: { providerName: true, statements: { orderBy: { statementDate: 'desc' }, take: 8, select: { id: true, statementDate: true, dueDate: true, amountDue: true, balance: true, amountPaid: true, paidOverride: true } } } });
      if (!a) return { error: 'No such account' };
      return { provider: a.providerName, statements: a.statements.map(s => ({ statementId: s.id, date: day(s.statementDate), due: day(s.dueDate), amountDue: n(s.amountDue), balance: n(s.balance), paid: n(s.amountPaid), markedPaid: s.paidOverride === 'PAID' })) };
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
  const make = (model: string) => client.messages.create({ ...paramsFor(model, { maxTokens: 2000, system: base.system, messages: base.messages }), tools: TOOLS });
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
  const system = `You are Sollux, the assistant inside a real-estate owner's property-management app (rentals, utilities, loans, taxes). Today is ${today}. Answer from the tools — never guess amounts, dates or ids. Look things up before answering; use find to get ids. Be brief: short sentences or bullets, dollar amounts and dates. To record a payment, call the matching log_* tool; it is only proposed — the owner confirms it on screen — so after proposing, say in one line what will be recorded. Do not claim anything was recorded.`;
  const messages: Anthropic.MessageParam[] = history.slice(-12).map(t => ({ role: t.role, content: t.content }));
  const actions: PendingAction[] = [];

  for (let step = 0; step < 8; step++) {
    const res = await create(client, { system, messages });
    const uses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
    const text = res.content.map(c => (c.type === 'text' ? c.text : '')).join('').trim();
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
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 20000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'That took too many steps — try asking more specifically.', actions };
}
