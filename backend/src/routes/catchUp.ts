/**
 * Catching up: the owner's records start partway, so months already paid
 * read as late — every loan payment never logged, every old bill nobody
 * marked. Two strokes clear them, on the owner's word:
 *
 *   loans  every month a loan has run, through a chosen month, without a
 *          payment covering it gets one (the scheduled amount, dated its
 *          due day), noted as caught up. A loan's balance is not touched.
 *   bills  the bills the owner ticks (the Bills page lists the ones it
 *          reads as unpaid) are marked paid (paidOverride PAID). A bill
 *          the owner pinned open (UNPAID) is left alone.
 *
 * The last catch-up is kept (app_settings `catch-up:<userId>`) so it can be
 * undone in one stroke: its loan payments deleted, its bills put back.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { dueDateFor } from '../services/loanTracker';
import { rentMonthsToCatchUp } from '../lib/rentCatchUp';

const router = Router();
router.use(attachDbUser);

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const NOTE = 'Caught up: marked paid in Sollux';
const ym = (d: Date) => d.toISOString().slice(0, 7);
const n = (v: unknown) => (v == null ? 0 : Number(v));
const key = (userId: string) => `catch-up:${userId}`;

function monthsFrom(from: string, through: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = through.split('-').map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 240) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  return out;
}

/** Each active loan's months, through `through`, with no payment logged. Loans without a start date go back to January this year. */
async function missingLoanMonths(userId: string, through: string, loanIds?: string[]) {
  const loans = await db.loan.findMany({
    where: { userId, isActive: true, utilityAccountId: null, ...(loanIds ? { id: { in: loanIds } } : {}) },
    select: {
      id: true, lender: true, monthlyPayment: true, escrowAmount: true, dueDay: true, originationDate: true, isPersonal: true, loanType: true,
      property: { select: { nickname: true, address: true } },
      loanPayments: { select: { amount: true, date: true, periodDate: true } },
    },
    orderBy: { lender: 'asc' },
  });
  const floor = `${new Date().getUTCFullYear() - 10}-01`;
  return loans.map(l => {
    const expected = Number((n(l.monthlyPayment) + n(l.escrowAmount)).toFixed(2));
    const start = l.originationDate ? ym(l.originationDate) : `${through.slice(0, 4)}-01`;
    // A loan's first payment is due the month after it starts.
    const first = monthsFrom(start, through)[1] ?? null;
    const months = expected > 0 && first ? monthsFrom(first > floor ? first : floor, through) : [];
    const paidBy = new Map<string, number>();
    for (const p of l.loanPayments) { const m = ym(p.periodDate ?? p.date); paidBy.set(m, (paidBy.get(m) ?? 0) + n(p.amount)); }
    // Only months with nothing logged: a month with any payment, part payment or not, is the owner's record and is left alone.
    const missing = months.filter(m => !paidBy.has(m)).map(m => ({ month: m, amount: expected }));
    return {
      loanId: l.id, lender: l.lender, loanType: l.loanType, isPersonal: l.isPersonal,
      property: l.property?.nickname || l.property?.address || null, dueDay: l.dueDay, expected, missing,
    };
  }).filter(l => l.missing.length);
}

// GET /api/catch-up/loans?through=YYYY-MM — what catching the loans up would add.
router.get('/loans', async (req, res, next) => {
  try {
    const through = Month.parse(req.query.through);
    const loans = await missingLoanMonths(req.dbUserId!, through);
    const last = await db.appSetting.findUnique({ where: { key: key(req.dbUserId!) } });
    res.json({ loans, lastCatchUp: last ? JSON.parse(last.value).at ?? null : null });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Give the month as YYYY-MM.' });
    next(err);
  }
});

// POST /api/catch-up { through, loanIds, statementIds }
router.post('/', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;
    const body = z.object({ through: Month, loanIds: z.array(z.string()).max(500), statementIds: z.array(z.string()).max(10000) }).parse(req.body);

    const loans = body.loanIds.length ? await missingLoanMonths(userId, body.through, body.loanIds) : [];
    const rows = loans.flatMap(l => l.missing.map(m => ({
      loanId: l.loanId, amount: m.amount, billAmount: l.expected, status: 'PAID' as const,
      date: new Date(`${dueDateFor(m.month, l.dueDay)}T00:00:00.000Z`), periodDate: new Date(`${m.month}-01T00:00:00.000Z`), notes: NOTE,
    })));

    // Only the owner's bills, and never one the owner pinned open.
    const bills = body.statementIds.length ? await db.statement.findMany({
      where: { id: { in: body.statementIds }, utilityAccount: { property: { userId } }, OR: [{ paidOverride: null }, { paidOverride: { not: 'UNPAID' } }] },
      select: { id: true, paidOverride: true },
    }) : [];

    const created = await db.$transaction(async tx => {
      const ids: string[] = [];
      for (const r of rows) ids.push((await tx.loanPayment.create({ data: r, select: { id: true } })).id);
      if (bills.length) await tx.statement.updateMany({ where: { id: { in: bills.map(b => b.id) } }, data: { paidOverride: 'PAID' } });
      const record = { at: new Date().toISOString(), loanPaymentIds: ids, bills: bills.map(b => ({ id: b.id, prev: b.paidOverride })) };
      await tx.appSetting.upsert({ where: { key: key(userId) }, create: { key: key(userId), value: JSON.stringify(record) }, update: { value: JSON.stringify(record) } });
      return ids.length;
    });
    res.json({ loanPayments: created, bills: bills.length });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Choose what to catch up.' });
    next(err);
  }
});

// POST /api/catch-up/undo — the last catch-up taken back.
router.post('/undo', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;
    const row = await db.appSetting.findUnique({ where: { key: key(userId) } });
    if (!row) return res.status(404).json({ error: 'There is no catch-up to undo.' });
    const rec = JSON.parse(row.value) as { loanPaymentIds: string[]; bills: { id: string; prev: string | null }[] };
    await db.$transaction(async tx => {
      await tx.loanPayment.deleteMany({ where: { id: { in: rec.loanPaymentIds }, loan: { userId }, notes: NOTE } });
      for (const b of rec.bills) {
        await tx.statement.updateMany({ where: { id: b.id, utilityAccount: { property: { userId } }, paidOverride: 'PAID' }, data: { paidOverride: b.prev } });
      }
      await tx.appSetting.delete({ where: { key: key(userId) } });
    });
    res.json({ loanPayments: rec.loanPaymentIds.length, bills: rec.bills.length });
  } catch (err) { next(err); }
});

// ── Rent ─────────────────────────────────────────────────────────────────────
// Active leases with nothing owed from earlier months: every month from
// move-in through `through` with no payment logged is recorded as paid at
// the rent then in effect (lib/rentCatchUp.ts). A lease with arrears is
// listed for the owner, untouched. Arrears balances are not changed. Undone
// in one stroke (app_settings `rent-catch-up:<userId>`).
const RENT_NOTE = 'Caught up: rent marked paid in Sollux';
const rentKey = (userId: string) => `rent-catch-up:${userId}`;

async function rentCatchUp(userId: string, through: string, leaseIds?: string[]) {
  const leases = await db.lease.findMany({
    where: { status: 'ACTIVE', unit: { property: { userId } }, ...(leaseIds ? { id: { in: leaseIds } } : {}) },
    select: {
      id: true, rentAmount: true, startDate: true, firstMonthRent: true, arrearsBalance: true, rentDueDay: true,
      unit: { select: { unitLabel: true, property: { select: { nickname: true, address: true } } } },
      leaseTenants: { select: { tenant: { select: { fullName: true } } } },
      rentChanges: { select: { effectiveDate: true, previousAmount: true, newAmount: true } },
      rentPayments: { select: { periodDate: true } },
    },
  });
  const ready: { leaseId: string; tenant: string; property: string; dueDay: number | null; months: { month: string; amount: number }[] }[] = [];
  const review: { leaseId: string; tenant: string; property: string; reason: string; arrears: number }[] = [];
  for (const l of leases) {
    const tenant = l.leaseTenants.map(t => t.tenant.fullName).join(', ') || 'Tenant';
    const property = `${l.unit.property.nickname || l.unit.property.address}${l.unit.unitLabel ? ` · ${l.unit.unitLabel}` : ''}`;
    const arrears = n(l.arrearsBalance);
    if (arrears > 0.005) { review.push({ leaseId: l.id, tenant, property, reason: 'owes from earlier months', arrears }); continue; }
    if (!l.startDate) { review.push({ leaseId: l.id, tenant, property, reason: 'no move-in date on the lease', arrears }); continue; }
    const paid = new Set(l.rentPayments.map(p => ym(p.periodDate)));
    const months = rentMonthsToCatchUp(l, l.rentChanges.map(c => ({ effectiveDate: c.effectiveDate, previousAmount: c.previousAmount == null ? null : n(c.previousAmount), newAmount: n(c.newAmount) })), paid, through);
    if (months.length) ready.push({ leaseId: l.id, tenant, property, dueDay: l.rentDueDay, months });
  }
  return { ready: ready.sort((a, b) => a.property.localeCompare(b.property)), review: review.sort((a, b) => b.arrears - a.arrears) };
}

// GET /api/catch-up/rent?through=YYYY-MM — what catching rent up would record, and the leases left to the owner.
router.get('/rent', async (req, res, next) => {
  try {
    const through = Month.parse(req.query.through);
    const r = await rentCatchUp(req.dbUserId!, through);
    const last = await db.appSetting.findUnique({ where: { key: rentKey(req.dbUserId!) } });
    res.json({ ...r, lastCatchUp: last ? JSON.parse(last.value).at ?? null : null });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Give the month as YYYY-MM.' });
    next(err);
  }
});

// POST /api/catch-up/rent { through, leaseIds }
router.post('/rent', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;
    const body = z.object({ through: Month, leaseIds: z.array(z.string()).min(1).max(1000) }).parse(req.body);
    const { ready } = await rentCatchUp(userId, body.through, body.leaseIds);
    const ids = await db.$transaction(async tx => {
      const out: string[] = [];
      for (const l of ready) for (const m of l.months) {
        const day = Math.min(l.dueDay ?? 1, 28);
        const p = await tx.rentPayment.create({ data: {
          leaseId: l.leaseId, periodDate: new Date(`${m.month}-01T00:00:00.000Z`), amount: m.amount,
          paidDate: new Date(`${m.month}-${String(day).padStart(2, '0')}T00:00:00.000Z`),
          method: 'OTHER', status: 'RECEIVED', appliedToArrears: 0, notes: RENT_NOTE,
        }, select: { id: true } });
        out.push(p.id);
      }
      const record = { at: new Date().toISOString(), rentPaymentIds: out };
      await tx.appSetting.upsert({ where: { key: rentKey(userId) }, create: { key: rentKey(userId), value: JSON.stringify(record) }, update: { value: JSON.stringify(record) } });
      return out;
    });
    res.json({ rentPayments: ids.length, leases: ready.length });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Choose the leases to catch up.' });
    next(err);
  }
});

// POST /api/catch-up/rent/undo — the last rent catch-up taken back.
router.post('/rent/undo', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;
    const row = await db.appSetting.findUnique({ where: { key: rentKey(userId) } });
    if (!row) return res.status(404).json({ error: 'There is no rent catch-up to undo.' });
    const rec = JSON.parse(row.value) as { rentPaymentIds: string[] };
    const r = await db.rentPayment.deleteMany({ where: { id: { in: rec.rentPaymentIds }, lease: { unit: { property: { userId } } }, notes: RENT_NOTE } });
    await db.appSetting.delete({ where: { key: rentKey(userId) } });
    res.json({ rentPayments: r.count });
  } catch (err) { next(err); }
});

export default router;
