/**
 * The Finances overview: for each property and month, rent against the
 * costs by type, the NOI, the loans and the cash flow — each figure beside
 * what was expected. One table instead of the P&L, cash flow and budget
 * pages, all read from the cost ledger (lib/costLedger.ts) so the numbers
 * agree with Finances → Costs.
 *
 * Actual rent is what was received in the month; expected is the rent roll.
 * A cost is actual in the month it was due ("charged") and, beside it, in
 * the month it was paid. Expected is automatic (lib/costTypes.ts): a bill
 * line's same month last year or its recent average, a loan's or policy's
 * schedule, a tax installment as billed, and logged costs at last year's
 * monthly average.
 */
import { db } from '../config/db';
import { buildLedger } from './costLedger';
import { expectedCharge, expectedAverage, monthsBetween, n, r2, ym, type CostType } from './costTypes';
import { scheduledRent, leaseSelect } from './pnl';

export interface Cell { expected: number; charged: number; paid: number }
export interface MonthFigures { rent: { expected: number; received: number }; types: Partial<Record<CostType, Cell>> }

export async function buildOverview(userId: string, year: number, propertyId?: string) {
  const months = monthsBetween(`${year}-01`, `${year}-12`);
  const ledger = await buildLedger(userId, `${year - 1}-01`, `${year}-12`, propertyId);
  const ids = ledger.properties.map(p => p.id);
  const yearStart = new Date(Date.UTC(year, 0, 1)), yearEnd = new Date(Date.UTC(year + 1, 0, 1));

  const [leases, rent] = await Promise.all([
    db.lease.findMany({
      where: { unit: { propertyId: { in: ids } }, OR: [{ startDate: null }, { startDate: { lt: yearEnd } }], AND: { OR: [{ status: 'ACTIVE' }, { endDate: null }, { endDate: { gt: yearStart } }] } },
      select: { ...leaseSelect, unit: { select: { propertyId: true } } },
    }),
    db.rentPayment.findMany({
      where: { status: 'RECEIVED', paidDate: { gte: yearStart, lt: yearEnd }, lease: { unit: { propertyId: { in: ids } } } },
      select: { amount: true, paidDate: true, lease: { select: { unit: { select: { propertyId: true } } } } },
    }),
  ]);

  const blank = (): MonthFigures => ({ rent: { expected: 0, received: 0 }, types: {} });
  const byProperty = new Map(ids.map(id => [id, Object.fromEntries(months.map(m => [m, blank()])) as Record<string, MonthFigures>]));
  const cell = (pid: string, m: string, t: CostType) => {
    const f = byProperty.get(pid)?.[m]; if (!f) return null;
    return (f.types[t] ??= { expected: 0, charged: 0, paid: 0 });
  };

  // Rent: the roll, and what came in.
  for (const pid of ids) {
    const mine = leases.filter(l => l.unit.propertyId === pid);
    if (!mine.length) continue;
    for (const m of months) {
      const [y, mm] = m.split('-').map(Number);
      byProperty.get(pid)![m].rent.expected = r2(scheduledRent(mine, { start: new Date(Date.UTC(y, mm - 1, 1)), end: new Date(Date.UTC(y, mm, 1)) }, true));
    }
  }
  for (const p of rent) {
    const f = byProperty.get(p.lease.unit.propertyId)?.[ym(p.paidDate)];
    if (f) f.rent.received = r2(f.rent.received + n(p.amount));
  }

  // Costs: actuals from every ledger line; expectations by source.
  const logged = new Map<string, Record<string, number>>(); // property|type -> month -> charged
  for (const line of ledger.lines) {
    const charged = Object.fromEntries(Object.entries(line.months).map(([m, f]) => [m, f.charged]));
    for (const m of months) {
      const c = cell(line.propertyId, m, line.type); if (!c) continue;
      c.charged = r2(c.charged + (line.months[m]?.charged ?? 0));
      c.paid = r2(c.paid + (line.months[m]?.paid ?? 0));
      if (line.source === 'account') c.expected = r2(c.expected + expectedCharge(charged, m));
      else if (line.source === 'loan' || line.source === 'policy') c.expected = r2(c.expected + (line.schedule?.[m] ?? 0));
      else if (line.source === 'tax') c.expected = r2(c.expected + (line.months[m]?.charged ?? 0));
    }
    if (line.source === 'expense') {
      const k = `${line.propertyId}|${line.type}`;
      const acc = logged.get(k) ?? {};
      for (const [m, v] of Object.entries(charged)) acc[m] = r2((acc[m] ?? 0) + v);
      logged.set(k, acc);
    }
  }
  for (const [k, charged] of logged) {
    const [pid, type] = k.split('|') as [string, CostType];
    for (const m of months) { const c = cell(pid, m, type); if (c) c.expected = r2(c.expected + expectedAverage(charged, m)); }
  }

  return {
    year, months, thisMonth: new Date().toISOString().slice(0, 7),
    properties: ledger.properties.map(p => ({ ...p, months: byProperty.get(p.id)! })),
  };
}
