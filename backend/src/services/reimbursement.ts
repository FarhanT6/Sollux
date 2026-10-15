/**
 * Tenant utility reimbursement.
 *
 * Some leases have the tenant repay a share of the property's utilities — 60%
 * of each water and electric bill, a flat $63.84 a month for trash. Until now
 * that was a spreadsheet rebuilt by hand every month or two: statement
 * periods copied over, amounts multiplied, monthly totals summed, a grand
 * total, and a note of what the tenant actually paid.
 *
 * Sollux already holds every statement. This turns the rules on a lease into
 * an invoice for any date range: each bill in the range at the tenant's
 * share, the flat charges per calendar month, credit from an earlier
 * overpayment applied, and a total. A statement can be billed to a tenant
 * once — the line's unique statementId enforces it — so an overlapping range
 * never bills the same water bill twice.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';

export type RuleMode = 'PERCENT' | 'FULL' | 'FLAT_MONTHLY';
export interface Rule {
  category: string;      // WATER | ELECTRIC | GAS | SEWER | TRASH | INTERNET | OTHER
  mode: RuleMode;
  value: number;         // percent for PERCENT, dollars/month for FLAT_MONTHLY, ignored for FULL
  label?: string;        // display name, defaults to the category
}

export interface LineDraft {
  /** Stable identity for excluding a line: the statement id, or flat:<category>:<YYYY-MM>. */
  key: string;
  kind: 'STATEMENT' | 'FLAT';
  category: string;
  label: string;
  statementId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  baseAmount: number;
  sharePercent: number | null;
  amount: number;
  sortKey: string;
}

export interface Draft {
  from: string;
  to: string;
  lines: LineDraft[];
  subtotal: number;
  creditAvailable: number;
  creditApplied: number;
  total: number;
  /** Statements in range that are already on an earlier invoice. */
  alreadyBilled: { statementId: string; label: string; period: string; invoiceId: string }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isNaN(n) ? 0 : n; };
const CATEGORY_LABEL: Record<string, string> = {
  WATER: 'Water', ELECTRIC: 'Electricity', GAS: 'Gas', SEWER: 'Sewer', TRASH: 'Trash',
  INTERNET: 'Internet', PHONE: 'Phone', OTHER: 'Other',
};

class ReimbursementError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export { ReimbursementError };

/** The lease, proven to belong to this user, with what an invoice needs to name. */
async function ownedLease(leaseId: string, userId: string) {
  const lease = await db.lease.findFirst({
    where: { id: leaseId, unit: { property: { userId } } },
    include: {
      unit: { include: { property: { select: { id: true, address: true, nickname: true, city: true, state: true } } } },
      leaseTenants: { include: { tenant: { select: { id: true, fullName: true, email: true } } } },
      utilityReimbursement: true,
    },
  });
  if (!lease) throw new ReimbursementError('Lease not found', 404);
  return lease;
}

export async function getConfig(leaseId: string, userId: string) {
  const lease = await ownedLease(leaseId, userId);
  const config = lease.utilityReimbursement;
  const invoices = config ? await db.reimbursementInvoice.findMany({
    where: { reimbursementId: config.id },
    orderBy: { periodEnd: 'desc' },
    select: {
      id: true, periodStart: true, periodEnd: true, subtotal: true, creditApplied: true, total: true,
      paidAmount: true, paidAt: true, status: true, createdAt: true, _count: { select: { lines: true } },
    },
  }) : [];
  // The accounts the rules could draw from, for the optional account picker.
  const accounts = await db.utilityAccount.findMany({
    where: { propertyId: lease.unit.propertyId, isActive: true },
    select: { id: true, providerName: true, serviceLabel: true, category: true, unitId: true },
    orderBy: { providerName: 'asc' },
  });
  return { lease, config, invoices, accounts };
}

export async function upsertConfig(leaseId: string, userId: string, input: { enabled: boolean; rules: Rule[]; accountIds?: string[]; notes?: string | null }) {
  await ownedLease(leaseId, userId);
  if (input.enabled && input.rules.length === 0) throw new ReimbursementError('Add at least one rule, or turn reimbursement off.');
  return db.utilityReimbursement.upsert({
    where: { leaseId },
    create: { leaseId, enabled: input.enabled, rulesJson: input.rules as unknown as Prisma.InputJsonValue, accountIdsJson: (input.accountIds ?? []) as Prisma.InputJsonValue, notes: input.notes ?? null },
    update: { enabled: input.enabled, rulesJson: input.rules as unknown as Prisma.InputJsonValue, accountIdsJson: (input.accountIds ?? []) as Prisma.InputJsonValue, notes: input.notes ?? null },
  });
}

/**
 * The invoice for a range, computed but not saved. Generation persists exactly
 * this, so what the owner previews is what the tenant gets.
 */
export async function draftInvoice(leaseId: string, userId: string, fromISO: string, toISO: string, exclude: string[] = []): Promise<Draft> {
  const lease = await ownedLease(leaseId, userId);
  const config = lease.utilityReimbursement;
  if (!config || !config.enabled) throw new ReimbursementError('This lease has no utility reimbursement set up.');
  const rules = (config.rulesJson as unknown as Rule[]) ?? [];
  const accountIds = ((config.accountIdsJson as unknown as string[]) ?? []).filter(Boolean);

  const from = new Date(fromISO), to = new Date(toISO);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) throw new ReimbursementError('Choose a valid date range.');

  const statementRules = rules.filter(r => r.mode !== 'FLAT_MONTHLY');
  const flatRules = rules.filter(r => r.mode === 'FLAT_MONTHLY');
  const lines: LineDraft[] = [];
  const alreadyBilled: Draft['alreadyBilled'] = [];

  if (statementRules.length) {
    // Meters tied to another unit are never the tenant's to pay for.
    const accounts = await db.utilityAccount.findMany({
      where: {
        propertyId: lease.unit.propertyId,
        category: { in: statementRules.map(r => r.category) as never[] },
        ...(accountIds.length ? { id: { in: accountIds } } : { OR: [{ unitId: null }, { unitId: lease.unitId }] }),
      },
      select: { id: true, providerName: true, serviceLabel: true, category: true },
    });
    const byAccount = new Map(accounts.map(a => [a.id, a]));

    const statements = await db.statement.findMany({
      where: {
        utilityAccountId: { in: accounts.map(a => a.id) },
        isDownPayment: false,
        OR: [
          { billingPeriodEnd: { gte: from, lte: to } },
          { billingPeriodEnd: null, statementDate: { gte: from, lte: to } },
        ],
      },
      select: { id: true, utilityAccountId: true, statementDate: true, billingPeriodStart: true, billingPeriodEnd: true, amountDue: true },
      orderBy: { statementDate: 'asc' },
    });

    const priorLines = await db.reimbursementInvoiceLine.findMany({
      where: { statementId: { in: statements.map(s => s.id) }, invoice: { reimbursementId: config.id } },
      select: { statementId: true, invoiceId: true },
    });
    const billed = new Map(priorLines.map(l => [l.statementId!, l.invoiceId]));

    for (const s of statements) {
      const acct = byAccount.get(s.utilityAccountId)!;
      const rule = statementRules.find(r => r.category === acct.category)!;
      const label = rule.label || CATEGORY_LABEL[acct.category] || acct.category;
      const period = s.billingPeriodStart && s.billingPeriodEnd
        ? `${s.billingPeriodStart.toISOString().slice(0, 10)} – ${s.billingPeriodEnd.toISOString().slice(0, 10)}`
        : s.statementDate.toISOString().slice(0, 10);
      if (billed.has(s.id)) { alreadyBilled.push({ statementId: s.id, label, period, invoiceId: billed.get(s.id)! }); continue; }
      const base = num(s.amountDue);
      const share = rule.mode === 'FULL' ? 100 : num(rule.value);
      lines.push({
        key: s.id,
        kind: 'STATEMENT', category: acct.category, label, statementId: s.id,
        periodStart: s.billingPeriodStart?.toISOString() ?? null,
        periodEnd: s.billingPeriodEnd?.toISOString() ?? null,
        baseAmount: round2(base), sharePercent: share, amount: round2(base * share / 100),
        sortKey: (s.billingPeriodEnd ?? s.statementDate).toISOString(),
      });
    }
  }

  // A flat charge for every calendar month the range touches.
  for (const rule of flatRules) {
    const label = rule.label || CATEGORY_LABEL[rule.category] || rule.category;
    let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    while (cursor <= last) {
      const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
      lines.push({
        key: `flat:${rule.category}:${cursor.toISOString().slice(0, 7)}`,
        kind: 'FLAT', category: rule.category,
        label: `${label} (${cursor.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })})`,
        statementId: null, periodStart: cursor.toISOString(), periodEnd: monthEnd.toISOString(),
        baseAmount: round2(num(rule.value)), sharePercent: null, amount: round2(num(rule.value)),
        sortKey: monthEnd.toISOString(),
      });
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }
  }

  // Lines the owner has struck out — a flat charge already billed on an
  // invoice made before Sollux, a bill settled some other way. The first
  // Sollux invoice after a run of hand-made ones needs this, and so does
  // any month with an "already paid" note.
  const excluded = new Set(exclude);
  const kept = lines.filter(l => !excluded.has(l.key)).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  lines.length = 0; lines.push(...kept);
  const subtotal = round2(lines.reduce((t, l) => t + l.amount, 0));
  const creditAvailable = num(config.creditBalance);
  const creditApplied = round2(Math.min(creditAvailable, Math.max(subtotal, 0)));
  return { from: fromISO, to: toISO, lines, subtotal, creditAvailable, creditApplied, total: round2(subtotal - creditApplied), alreadyBilled };
}

/** Payment terms the owner sets by hand: a due date (none means the invoice
 *  prints none), whom to pay, and how. */
export interface InvoiceTerms { dueDate?: string | null; payableTo?: string | null; paymentInstructions?: string | null }

const cleanTerms = (t: InvoiceTerms | undefined) => ({
  dueDate: t?.dueDate ? new Date(t.dueDate) : null,
  payableTo: t?.payableTo?.trim() || null,
  paymentInstructions: t?.paymentInstructions?.trim() || null,
});

export async function createInvoice(leaseId: string, userId: string, fromISO: string, toISO: string, exclude: string[] = [], terms?: InvoiceTerms) {
  const draft = await draftInvoice(leaseId, userId, fromISO, toISO, exclude);
  if (draft.lines.length === 0) throw new ReimbursementError('Nothing to bill in that range — no statements, and no flat charges.');
  const config = (await db.utilityReimbursement.findUnique({ where: { leaseId } }))!;
  const t = cleanTerms(terms);

  return db.$transaction(async tx => {
    // Whom to pay and how are remembered on the lease for the next invoice.
    if (t.payableTo || t.paymentInstructions) {
      await tx.utilityReimbursement.update({ where: { id: config.id }, data: { payableTo: t.payableTo, paymentInstructions: t.paymentInstructions } });
    }
    const invoice = await tx.reimbursementInvoice.create({
      data: {
        reimbursementId: config.id,
        periodStart: new Date(draft.from), periodEnd: new Date(draft.to),
        subtotal: draft.subtotal, creditApplied: draft.creditApplied, total: draft.total,
        dueDate: t.dueDate, payableTo: t.payableTo, paymentInstructions: t.paymentInstructions,
        lines: {
          create: draft.lines.map(l => ({
            kind: l.kind, category: l.category, label: l.label, statementId: l.statementId,
            periodStart: l.periodStart ? new Date(l.periodStart) : null,
            periodEnd: l.periodEnd ? new Date(l.periodEnd) : null,
            baseAmount: l.baseAmount, sharePercent: l.sharePercent, amount: l.amount,
            sortKey: new Date(l.sortKey),
          })),
        },
      },
    });
    if (draft.creditApplied > 0) {
      await tx.utilityReimbursement.update({ where: { id: config.id }, data: { creditBalance: { decrement: draft.creditApplied } } });
    }
    return invoice;
  });
}

export async function getInvoice(invoiceId: string, userId: string) {
  const invoice = await db.reimbursementInvoice.findFirst({
    where: { id: invoiceId, reimbursement: { lease: { unit: { property: { userId } } } } },
    include: {
      lines: { orderBy: { sortKey: 'asc' } },
      reimbursement: {
        include: {
          lease: {
            include: {
              unit: { include: { property: { select: { id: true, address: true, nickname: true, city: true, state: true, zip: true } } } },
              leaseTenants: { include: { tenant: { select: { fullName: true, email: true } } } },
            },
          },
        },
      },
    },
  });
  if (!invoice) throw new ReimbursementError('Invoice not found', 404);
  const letterhead = await db.paymentRecipient.findUnique({ where: { userId } });

  // INV-2026-007: the owner's seventh invoice of the year, across every
  // lease. Derived from creation order rather than stored, so it never needs
  // renumbering and a deleted draft leaves no hole worth explaining.
  const year = invoice.createdAt.getUTCFullYear();
  const earlier = await db.reimbursementInvoice.count({
    where: {
      reimbursement: { lease: { unit: { property: { userId } } } },
      createdAt: { gte: new Date(Date.UTC(year, 0, 1)), lt: invoice.createdAt },
    },
  });
  const number = `INV-${year}-${String(earlier + 1).padStart(3, '0')}`;
  return { ...invoice, letterhead, number };
}

/**
 * What the tenant paid. Paying more than the total banks the excess as credit
 * against the next invoice — which is exactly the "amount they paid more"
 * line at the bottom of the old spreadsheet, kept instead of re-derived.
 */
export async function recordPayment(invoiceId: string, userId: string, amount: number, paidAtISO?: string) {
  if (!(amount > 0)) throw new ReimbursementError('Enter an amount greater than zero.');
  const invoice = await getInvoice(invoiceId, userId);
  const before = num(invoice.paidAmount), total = num(invoice.total);
  const after = round2(before + amount);
  const excessBefore = Math.max(0, before - total), excessAfter = Math.max(0, after - total);
  const newCredit = round2(excessAfter - excessBefore);

  return db.$transaction(async tx => {
    const updated = await tx.reimbursementInvoice.update({
      where: { id: invoiceId },
      data: {
        paidAmount: after,
        paidAt: paidAtISO ? new Date(paidAtISO) : new Date(),
        status: after >= total - 0.01 ? 'PAID' : 'PARTIAL',
      },
    });
    if (newCredit > 0) {
      await tx.utilityReimbursement.update({ where: { id: invoice.reimbursementId }, data: { creditBalance: { increment: newCredit } } });
    }
    return updated;
  });
}

export async function setStatus(invoiceId: string, userId: string, status: 'DRAFT' | 'SENT', notes?: string | null) {
  await getInvoice(invoiceId, userId);
  return db.reimbursementInvoice.update({ where: { id: invoiceId }, data: { status, ...(notes !== undefined ? { notes } : {}) } });
}

/** The payment terms on an invoice already made, and the lease's defaults with them. */
export async function updateTerms(invoiceId: string, userId: string, terms: InvoiceTerms) {
  const invoice = await getInvoice(invoiceId, userId);
  const t = cleanTerms(terms);
  return db.$transaction(async tx => {
    if (t.payableTo || t.paymentInstructions) {
      await tx.utilityReimbursement.update({ where: { id: invoice.reimbursementId }, data: { payableTo: t.payableTo, paymentInstructions: t.paymentInstructions } });
    }
    return tx.reimbursementInvoice.update({ where: { id: invoiceId }, data: t });
  });
}

/** Deleting frees its statements to be billed again and returns any credit it consumed. */
export async function deleteInvoice(invoiceId: string, userId: string) {
  const invoice = await getInvoice(invoiceId, userId);
  if (num(invoice.paidAmount) > 0) throw new ReimbursementError('This invoice has a payment recorded against it. Remove that first.');
  await db.$transaction(async tx => {
    if (num(invoice.creditApplied) > 0) {
      await tx.utilityReimbursement.update({ where: { id: invoice.reimbursementId }, data: { creditBalance: { increment: num(invoice.creditApplied) } } });
    }
    await tx.reimbursementInvoice.delete({ where: { id: invoiceId } });
  });
}

// ── Letterhead ──────────────────────────────────────────────────────────────

/**
 * Who the invoice is from and who the tenant pays. The owner's entity — a
 * trust, an LLC, a name — with an address and contact line. Stored once and
 * printed on every invoice, so the tenant sees the same payee every time.
 */
export async function getLetterhead(userId: string) {
  return db.paymentRecipient.findUnique({ where: { userId } });
}

export async function upsertLetterhead(userId: string, input: { name: string; address?: string | null; phone?: string | null; email?: string | null }) {
  if (!input.name.trim()) throw new ReimbursementError('The letterhead needs a name.');
  return db.paymentRecipient.upsert({
    where: { userId },
    create: { userId, name: input.name.trim(), address: input.address ?? null, phone: input.phone ?? null, email: input.email ?? null },
    update: { name: input.name.trim(), address: input.address ?? null, phone: input.phone ?? null, email: input.email ?? null },
  });
}

// ── Reimbursement payments ─────────────────────────────────────────────────
//
// What a tenant paid back for utilities, logged from the tenant's row like a
// rent payment and matched to the bills it covers: which utility account and
// month, how much of each. A bill on an invoice counts the payment on that
// invoice too, so the two ways of tracking it never disagree.

export interface ReimbursableItem {
  /** The statement id, or flat:<category>:<YYYY-MM>. */
  key: string;
  utilityAccountId: string | null;
  statementId: string | null;
  category: string;
  /** "SDG&E · Electricity" */
  label: string;
  /** First of the month the bill is for (its period end, else its statement date). */
  periodDate: string;
  /** Billing period or statement date, for display. */
  period: string;
  billAmount: number;
  sharePercent: number | null;
  owed: number;
  paid: number;
  outstanding: number;
  invoiceId: string | null;
}

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

const flatKey = (category: string, month: Date) => `flat:${category}:${month.toISOString().slice(0, 7)}`;
const lineKey = (l: { statementId: string | null; category: string; periodStart: Date | null; sortKey: Date }) =>
  l.statementId ?? flatKey(l.category, monthStart(l.periodStart ?? l.sortKey));

/**
 * How much of each line of an invoice has been reimbursed: the payments
 * matched to the line, then any payment recorded on the invoice as a lump sum
 * (before payments were matched to bills) spread over its lines oldest first.
 */
async function invoiceLinePaid(invoices: { id: string; paidAmount: unknown; lines: { statementId: string | null; category: string; periodStart: Date | null; sortKey: Date; amount: unknown }[] }[]) {
  const allocs = invoices.length ? await db.reimbursementAllocation.findMany({
    where: { invoiceId: { in: invoices.map(i => i.id) } },
    select: { invoiceId: true, statementId: true, category: true, periodDate: true, amount: true },
  }) : [];
  const paid = new Map<string, number>(); // `${invoiceId}|${key}`
  for (const inv of invoices) {
    const mine = allocs.filter(a => a.invoiceId === inv.id);
    for (const a of mine) {
      const k = `${inv.id}|${a.statementId ?? flatKey(a.category, a.periodDate)}`;
      paid.set(k, (paid.get(k) ?? 0) + num(a.amount));
    }
    let lump = round2(num(inv.paidAmount) - mine.reduce((t, a) => t + num(a.amount), 0));
    for (const l of [...inv.lines].sort((a, b) => a.sortKey.getTime() - b.sortKey.getTime())) {
      if (lump <= 0) break;
      const k = `${inv.id}|${lineKey(l)}`;
      const take = Math.min(lump, Math.max(0, num(l.amount) - (paid.get(k) ?? 0)));
      if (take > 0) { paid.set(k, round2((paid.get(k) ?? 0) + take)); lump = round2(lump - take); }
    }
  }
  return paid;
}

export interface OpenInvoice {
  id: string; periodStart: string; periodEnd: string; total: number; paidAmount: number; outstanding: number; status: string;
}

/**
 * What a tenant could be paying back. Invoices first, each line with what is
 * still owed on it; then bills not on any invoice (newest first). With rules
 * on the lease, their accounts and shares; without, every utility account on
 * the property that is not another unit's meter, at the whole bill.
 */
export async function reimbursableItems(leaseId: string, userId: string, months = 12): Promise<{ invoices: OpenInvoice[]; items: ReimbursableItem[] }> {
  const lease = await ownedLease(leaseId, userId);
  const config = lease.utilityReimbursement?.enabled ? lease.utilityReimbursement : null;
  const rules = config ? ((config.rulesJson as unknown as Rule[]) ?? []) : [];
  const accountIds = config ? ((config.accountIdsJson as unknown as string[]) ?? []).filter(Boolean) : [];
  const statementRules = rules.filter(r => r.mode !== 'FLAT_MONTHLY');
  const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - months + 1, 1));

  const accounts = await db.utilityAccount.findMany({
    where: {
      propertyId: lease.unit.propertyId,
      ...(config && statementRules.length ? { category: { in: statementRules.map(r => r.category) as never[] } } : {}),
      ...(accountIds.length ? { id: { in: accountIds } } : { OR: [{ unitId: null }, { unitId: lease.unitId }] }),
    },
    select: { id: true, providerName: true, serviceLabel: true, category: true },
  });
  const accountLabel = (a: { providerName: string; serviceLabel: string | null; category: string }) =>
    `${a.providerName} · ${a.serviceLabel || CATEGORY_LABEL[a.category] || a.category}`;

  // Invoices and their lines.
  const invoices = config ? await db.reimbursementInvoice.findMany({
    where: { reimbursementId: config.id },
    include: { lines: true },
    orderBy: { periodEnd: 'asc' },
  }) : [];
  const linePaid = await invoiceLinePaid(invoices);
  const invoiced = new Set<string>();
  const lineStatements = await db.statement.findMany({
    where: { id: { in: invoices.flatMap(i => i.lines.map(l => l.statementId).filter((x): x is string => !!x)) } },
    select: { id: true, utilityAccount: { select: { id: true, providerName: true, serviceLabel: true, category: true } } },
  });
  const stAcct = new Map(lineStatements.map(s => [s.id, s.utilityAccount]));

  const items: ReimbursableItem[] = [];
  for (const inv of invoices) {
    for (const l of inv.lines.sort((a, b) => a.sortKey.getTime() - b.sortKey.getTime())) {
      const key = lineKey(l);
      invoiced.add(key);
      const acct = l.statementId ? stAcct.get(l.statementId) : null;
      const owed = round2(num(l.amount));
      const paid = round2(linePaid.get(`${inv.id}|${key}`) ?? 0);
      items.push({
        key, utilityAccountId: acct?.id ?? null, statementId: l.statementId, category: l.category,
        label: acct ? accountLabel(acct) : l.label,
        periodDate: monthStart(l.kind === 'FLAT' ? (l.periodStart ?? l.sortKey) : l.sortKey).toISOString(),
        period: l.periodStart && l.periodEnd ? `${l.periodStart.toISOString().slice(0, 10)} – ${l.periodEnd.toISOString().slice(0, 10)}` : l.sortKey.toISOString().slice(0, 10),
        billAmount: round2(num(l.baseAmount)), sharePercent: l.kind === 'FLAT' || l.sharePercent == null || l.sharePercent === 100 ? null : l.sharePercent,
        owed, paid, outstanding: round2(Math.max(0, owed - paid)), invoiceId: inv.id,
      });
    }
  }

  // Bills on no invoice.
  const billAccounts = config && !statementRules.length ? [] : accounts;
  const byAccount = new Map(billAccounts.map(a => [a.id, a]));
  const statements = billAccounts.length ? await db.statement.findMany({
    where: {
      utilityAccountId: { in: billAccounts.map(a => a.id) },
      isDownPayment: false, isScheduled: false,
      OR: [{ billingPeriodEnd: { gte: since } }, { billingPeriodEnd: null, statementDate: { gte: since } }],
    },
    select: { id: true, utilityAccountId: true, statementDate: true, billingPeriodStart: true, billingPeriodEnd: true, amountDue: true },
    orderBy: { statementDate: 'desc' },
  }) : [];
  const allocs = await db.reimbursementAllocation.findMany({
    where: { payment: { leaseId }, invoiceId: null },
    select: { statementId: true, category: true, periodDate: true, amount: true },
  });
  const paidOn = new Map<string, number>();
  for (const a of allocs) {
    const k = a.statementId ?? flatKey(a.category, a.periodDate);
    paidOn.set(k, (paidOn.get(k) ?? 0) + num(a.amount));
  }
  const loose = (it: Omit<ReimbursableItem, 'paid' | 'outstanding' | 'invoiceId'>): ReimbursableItem => {
    const paid = round2(paidOn.get(it.key) ?? 0);
    return { ...it, paid, outstanding: round2(Math.max(0, it.owed - paid)), invoiceId: null };
  };
  const looseItems: ReimbursableItem[] = [];
  for (const s of statements) {
    if (invoiced.has(s.id)) continue;
    const acct = byAccount.get(s.utilityAccountId)!;
    const rule = statementRules.find(r => r.category === acct.category);
    const share = rule ? (rule.mode === 'FULL' ? 100 : num(rule.value)) : 100;
    const base = num(s.amountDue);
    looseItems.push(loose({
      key: s.id, utilityAccountId: acct.id, statementId: s.id, category: acct.category, label: accountLabel(acct),
      periodDate: monthStart(s.billingPeriodEnd ?? s.statementDate).toISOString(),
      period: s.billingPeriodStart && s.billingPeriodEnd
        ? `${s.billingPeriodStart.toISOString().slice(0, 10)} – ${s.billingPeriodEnd.toISOString().slice(0, 10)}`
        : `billed ${s.statementDate.toISOString().slice(0, 10)}`,
      billAmount: round2(base), sharePercent: share === 100 ? null : share, owed: round2(base * share / 100),
    }));
  }
  for (const rule of rules.filter(r => r.mode === 'FLAT_MONTHLY')) {
    for (let m = 0; m < months; m++) {
      const p = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - m, 1));
      const key = flatKey(rule.category, p);
      if (invoiced.has(key)) continue;
      looseItems.push(loose({
        key, utilityAccountId: null, statementId: null, category: rule.category,
        label: `${rule.label || CATEGORY_LABEL[rule.category] || rule.category} (flat monthly)`,
        periodDate: p.toISOString(), period: p.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
        billAmount: round2(num(rule.value)), sharePercent: null, owed: round2(num(rule.value)),
      }));
    }
  }
  looseItems.sort((a, b) => b.periodDate.localeCompare(a.periodDate) || a.label.localeCompare(b.label));

  const open: OpenInvoice[] = invoices.slice().reverse().map(inv => {
    const total = round2(num(inv.total)), paid = round2(num(inv.paidAmount));
    return { id: inv.id, periodStart: inv.periodStart.toISOString(), periodEnd: inv.periodEnd.toISOString(), total, paidAmount: paid, outstanding: round2(Math.max(0, total - paid)), status: inv.status };
  });
  return { invoices: open, items: [...items, ...looseItems] };
}

export interface ReimbursementPaymentInput {
  amount: number;
  paidDate: string;
  method: string;
  bankAccountId?: string | null;
  notes?: string | null;
  allocations: { key: string; amount: number }[];
  /** Paying one invoice: what is not matched to its lines is still counted on it (an overpayment becomes credit). */
  invoiceId?: string | null;
}

/** Log what the tenant paid back and the bills it covers. */
export async function recordReimbursementPayment(leaseId: string, userId: string, input: ReimbursementPaymentInput) {
  if (!(input.amount > 0)) throw new ReimbursementError('Enter an amount greater than zero.');
  const allocations = input.allocations.filter(a => a.amount > 0);
  const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
  if (allocated > input.amount + 0.005) throw new ReimbursementError(`The bills add up to $${allocated.toFixed(2)}, more than the $${input.amount.toFixed(2)} paid.`);
  if (input.bankAccountId) {
    const acct = await db.bankAccount.findFirst({ where: { id: input.bankAccountId, userId }, select: { id: true } });
    if (!acct) throw new ReimbursementError('Bank account not found', 404);
  }
  const owed = await reimbursableItems(leaseId, userId, 36);
  // An invoiced bill is matched on its invoice, never as a loose bill.
  const items = new Map<string, ReimbursableItem>();
  for (const i of owed.items) if (!items.has(i.key) || i.invoiceId) items.set(i.key, i);
  for (const a of allocations) if (!items.has(a.key)) throw new ReimbursementError('One of the bills picked is not on this lease.');
  if (input.invoiceId && !owed.invoices.some(i => i.id === input.invoiceId)) throw new ReimbursementError('Invoice not found', 404);

  const paidAt = new Date(input.paidDate);
  const payment = await db.reimbursementPayment.create({
    data: {
      leaseId, amount: input.amount, paidDate: paidAt, method: input.method as any,
      bankAccountId: input.bankAccountId ?? null, notes: input.notes ?? null,
      allocations: {
        create: allocations.map(a => {
          const it = items.get(a.key)!;
          return { utilityAccountId: it.utilityAccountId, statementId: it.statementId, category: it.category, periodDate: new Date(it.periodDate), invoiceId: it.invoiceId, amount: round2(a.amount) };
        }),
      },
    },
    include: { allocations: true },
  });
  // Bills on an invoice: the invoice shows the payment too.
  const perInvoice = new Map<string, number>();
  for (const a of payment.allocations) if (a.invoiceId) perInvoice.set(a.invoiceId, (perInvoice.get(a.invoiceId) ?? 0) + num(a.amount));
  // Paying an invoice: the rest of the money counts on it too, so an overpayment banks as credit.
  if (input.invoiceId) {
    const rest = round2(input.amount - allocated);
    if (rest > 0) perInvoice.set(input.invoiceId, (perInvoice.get(input.invoiceId) ?? 0) + rest);
    await db.reimbursementPayment.update({ where: { id: payment.id }, data: { invoiceId: input.invoiceId } });
  }
  for (const [invoiceId, amt] of perInvoice) await recordPayment(invoiceId, userId, round2(amt), input.paidDate);
  return payment;
}

export async function listReimbursementPayments(leaseId: string, userId: string) {
  await ownedLease(leaseId, userId);
  return db.reimbursementPayment.findMany({
    where: { leaseId },
    include: { allocations: true, bankAccount: { select: { id: true, name: true, bank: true, last4: true } } },
    orderBy: { paidDate: 'desc' },
  });
}

/** Remove a logged reimbursement, and take it back off any invoice it paid toward. */
export async function deleteReimbursementPayment(paymentId: string, userId: string) {
  const p = await db.reimbursementPayment.findFirst({
    where: { id: paymentId, lease: { unit: { property: { userId } } } },
    include: { allocations: true },
  });
  if (!p) throw new ReimbursementError('Payment not found', 404);
  const perInvoice = new Map<string, number>();
  for (const a of p.allocations) if (a.invoiceId) perInvoice.set(a.invoiceId, (perInvoice.get(a.invoiceId) ?? 0) + num(a.amount));
  if (p.invoiceId) {
    const rest = round2(num(p.amount) - p.allocations.reduce((t, a) => t + num(a.amount), 0));
    if (rest > 0) perInvoice.set(p.invoiceId, (perInvoice.get(p.invoiceId) ?? 0) + rest);
  }
  await db.$transaction(async tx => {
    for (const [invoiceId, amt] of perInvoice) {
      const inv = await tx.reimbursementInvoice.findUnique({ where: { id: invoiceId } });
      if (!inv) continue;
      const before = num(inv.paidAmount), total = num(inv.total);
      const after = round2(Math.max(0, before - amt));
      // Credit an overpayment created goes away with it.
      const creditBack = round2(Math.max(0, before - total) - Math.max(0, after - total));
      await tx.reimbursementInvoice.update({
        where: { id: invoiceId },
        data: { paidAmount: after, status: after <= 0 ? 'SENT' : after >= total - 0.01 ? 'PAID' : 'PARTIAL', ...(after <= 0 ? { paidAt: null } : {}) },
      });
      if (creditBack > 0) {
        const cfg = await tx.utilityReimbursement.findUnique({ where: { id: inv.reimbursementId }, select: { creditBalance: true } });
        await tx.utilityReimbursement.update({ where: { id: inv.reimbursementId }, data: { creditBalance: Math.max(0, round2(num(cfg?.creditBalance) - creditBack)) } });
      }
    }
    await tx.reimbursementAllocation.deleteMany({ where: { paymentId: p.id } });
    await tx.reimbursementPayment.delete({ where: { id: p.id } });
  });
}

/**
 * A payment recorded on an invoice: logged like any reimbursement, matched to
 * the invoice's unpaid lines oldest first, the rest counted on the invoice.
 */
export async function payInvoice(invoiceId: string, userId: string, input: { amount: number; paidAt?: string; method?: string; bankAccountId?: string | null; notes?: string | null }) {
  const invoice = await getInvoice(invoiceId, userId);
  const leaseId = invoice.reimbursement.leaseId;
  const { items } = await reimbursableItems(leaseId, userId, 36);
  let left = round2(input.amount);
  const allocations: { key: string; amount: number }[] = [];
  for (const it of items.filter(i => i.invoiceId === invoiceId && i.outstanding > 0).sort((a, b) => a.periodDate.localeCompare(b.periodDate))) {
    if (left <= 0) break;
    const take = round2(Math.min(left, it.outstanding));
    allocations.push({ key: it.key, amount: take });
    left = round2(left - take);
  }
  return recordReimbursementPayment(leaseId, userId, {
    amount: input.amount, paidDate: input.paidAt || new Date().toISOString().slice(0, 10), method: input.method ?? 'OTHER',
    bankAccountId: input.bankAccountId ?? null, notes: input.notes ?? null, allocations, invoiceId,
  });
}

/** Each line's reimbursed amount and the payments that went to an invoice, for the invoice page. */
export async function invoicePayments(invoiceId: string, userId: string) {
  const invoice = await getInvoice(invoiceId, userId);
  const paid = await invoiceLinePaid([invoice]);
  const lines = Object.fromEntries(invoice.lines.map(l => [l.id, round2(paid.get(`${invoice.id}|${lineKey(l)}`) ?? 0)]));
  const payments = await db.reimbursementPayment.findMany({
    where: { OR: [{ invoiceId }, { allocations: { some: { invoiceId } } }] },
    include: { allocations: { where: { invoiceId } } },
    orderBy: { paidDate: 'asc' },
  });
  const rows = payments.map(p => {
    const onLines = p.allocations.reduce((t, a) => t + num(a.amount), 0);
    const onInvoice = p.invoiceId === invoiceId ? num(p.amount) : onLines;
    return { id: p.id, paidDate: p.paidDate, method: p.method, amount: round2(onInvoice) };
  });
  // Recorded on the invoice before payments were logged one by one.
  const logged = rows.reduce((t, r) => t + r.amount, 0);
  const earlier = round2(num(invoice.paidAmount) - logged);
  return { lines, payments: rows, earlier: earlier > 0.005 ? earlier : 0 };
}
