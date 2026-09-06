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

export async function createInvoice(leaseId: string, userId: string, fromISO: string, toISO: string, exclude: string[] = []) {
  const draft = await draftInvoice(leaseId, userId, fromISO, toISO, exclude);
  if (draft.lines.length === 0) throw new ReimbursementError('Nothing to bill in that range — no statements, and no flat charges.');
  const config = (await db.utilityReimbursement.findUnique({ where: { leaseId } }))!;

  return db.$transaction(async tx => {
    const invoice = await tx.reimbursementInvoice.create({
      data: {
        reimbursementId: config.id,
        periodStart: new Date(draft.from), periodEnd: new Date(draft.to),
        subtotal: draft.subtotal, creditApplied: draft.creditApplied, total: draft.total,
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
  return { ...invoice, letterhead };
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
