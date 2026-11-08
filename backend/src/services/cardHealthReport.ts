/**
 * Each card's history and costs (lib/cardHealth) and the household's credit
 * insights (lib/cardInsights), from the cards, their statements, the
 * statements' fee / payment / credit / interest lines and the payments.
 */
import { db } from '../config/db';
import { cardHealth, type HStatement } from '../lib/cardHealth';
import { cardInsights, type InsightCard } from '../lib/cardInsights';
import { cardPosition } from './creditCards';

const DAY = 86_400_000;

async function load(where: Record<string, unknown>) {
  return db.creditCard.findMany({
    where,
    include: {
      statements: { orderBy: { closingDate: 'desc' }, include: { transactions: { where: { kind: { not: 'PURCHASE' } }, select: { date: true, amount: true, kind: true, description: true } } } },
      payments: { orderBy: { date: 'desc' } },
    },
    orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}
type Loaded = Awaited<ReturnType<typeof load>>[number];

const newestApr = (c: Loaded) => { const s = c.statements.find(x => x.purchaseApr != null); return s ? Number(s.purchaseApr) : null; };

function healthOf(c: Loaded, today: Date) {
  const statements: HStatement[] = c.statements.map(s => ({
    id: s.id, closingDate: s.closingDate, dueDate: s.dueDate, minimumPayment: s.minimumPayment == null ? null : Number(s.minimumPayment),
    newBalance: Number(s.newBalance), interestCharged: s.interestCharged == null ? null : Number(s.interestCharged), feesCharged: s.feesCharged == null ? null : Number(s.feesCharged),
    pastDueAmount: s.pastDueAmount == null ? null : Number(s.pastDueAmount), fromEmail: s.fromEmail,
    lines: s.transactions.map(t => ({ date: t.date, amount: Number(t.amount), kind: t.kind, description: t.description })),
  }));
  return cardHealth(statements, c.payments.map(p => ({ date: p.date, amount: Number(p.amount) })), today);
}

/** One card's history and costs. */
export async function oneCardHealth(userId: string, cardId: string, today = new Date()) {
  const [c] = await load({ id: cardId, userId });
  return c ? healthOf(c, today) : null;
}

/** Every card's history, the credit snapshot and the insights — for one person's cards with `member`. */
export async function creditHealth(userId: string, memberWhere: Record<string, unknown> = {}, today = new Date()) {
  const cards = await load({ userId, ...memberWhere });
  const rows: (InsightCard & { last4: string | null })[] = cards.map(c => {
    const position = cardPosition(c);
    const health = healthOf(c, today);
    const newest = c.statements.find(s => !s.fromEmail);
    const since = today.getTime() - 90 * DAY;
    const paid90 = c.payments.filter(p => p.date.getTime() >= since).reduce((t, p) => t + Number(p.amount), 0);
    return {
      id: c.id, name: c.name, last4: c.last4, status: c.status, autopay: c.autopay, phone: c.phone,
      penaltyApr: c.penaltyApr == null ? null : Number(c.penaltyApr), purchaseApr: c.purchaseApr != null ? Number(c.purchaseApr) : newestApr(c), annualFee: c.annualFee == null ? null : Number(c.annualFee),
      position: {
        balance: position.balance, limit: position.limit, utilization: position.utilization, apr: position.apr, introActive: position.introActive,
        monthlyInterest: position.monthlyInterest, minimumPayment: position.minimumPayment, statementStatus: position.statementStatus,
        minimumRemaining: position.minimumRemaining, nextDueDate: position.nextDueDate,
      },
      health,
      promotions: Array.isArray(newest?.promotions) ? (newest!.promotions as any[]).filter(p => p && typeof p.payBy === 'string').map(p => ({ balance: Number(p.balance), payBy: String(p.payBy) })) : [],
      paid90: Math.max(0, paid90),
      minPayoffMonths: newest?.minPayoffMonths ?? null,
    };
  });
  const { insights, snapshot } = cardInsights(rows, today);
  return {
    snapshot, insights,
    cards: rows.map(r => ({ id: r.id, name: r.name, last4: r.last4, status: r.status, utilization: r.position.utilization, balance: r.position.balance, limit: r.position.limit, health: { ...r.health, history: r.health.history.slice(0, 13), costs: r.health.costs.slice(0, 24) } })),
  };
}
