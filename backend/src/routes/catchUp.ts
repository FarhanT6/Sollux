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

/** Each active loan's months, through `through`, that no payment covers. Loans without a start date go back to January this year. */
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
    const missing = months.filter(m => (paidBy.get(m) ?? 0) < expected - 0.5).map(m => ({ month: m, amount: Number((expected - (paidBy.get(m) ?? 0)).toFixed(2)) }));
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

export default router;
