/**
 * A credit card's position, worked out from what is on file: its terms, its
 * statements, and the payments made since. One place for the arithmetic so
 * the list, the card page and the personal overview agree.
 */

const n = (v: unknown): number | null => (v == null ? null : Number(v));
const r2 = (v: number) => Number(v.toFixed(2));
const dayStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** The next date (today or later) that falls on this day of the month. */
export function nextDayOfMonth(dayOfMonth: number, from = new Date()): Date {
  const t = dayStart(from);
  const clamp = (y: number, m: number) => Math.min(dayOfMonth, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  let d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), clamp(t.getUTCFullYear(), t.getUTCMonth())));
  if (d < t) {
    const y = t.getUTCMonth() === 11 ? t.getUTCFullYear() + 1 : t.getUTCFullYear();
    const m = (t.getUTCMonth() + 1) % 12;
    d = new Date(Date.UTC(y, m, clamp(y, m)));
  }
  return d;
}

export type StatementStatus = 'PAID_IN_FULL' | 'MINIMUM_MET' | 'DUE' | 'PAST_DUE' | 'NO_BALANCE';

export function cardPosition(card: any) {
  const today = dayStart();
  const statements = [...(card.statements ?? [])].sort((a, b) => +new Date(b.closingDate) - +new Date(a.closingDate));
  const payments = card.payments ?? [];
  const latest = statements[0] ?? null;
  const closedAt = latest ? new Date(latest.closingDate) : null;
  const paidSinceClose = closedAt ? payments.filter((p: any) => new Date(p.date) > closedAt).reduce((t: number, p: any) => t + Number(p.amount), 0) : 0;

  // The balance now: an entered balance when it is newer than the statement,
  // else the statement's balance less what has been paid since it closed.
  const entered = n(card.currentBalance);
  const enteredAt = card.balanceAsOf ? new Date(card.balanceAsOf) : null;
  let balance: number;
  let balanceSource: 'ENTERED' | 'STATEMENT' | 'NONE';
  if (entered != null && (!closedAt || (enteredAt && enteredAt > closedAt))) { balance = entered; balanceSource = 'ENTERED'; }
  else if (latest) { balance = r2(Number(latest.newBalance) - paidSinceClose); balanceSource = 'STATEMENT'; }
  else { balance = entered ?? 0; balanceSource = entered != null ? 'ENTERED' : 'NONE'; }

  // The newest statement: paid in full, minimum met, due, or past due.
  let statementStatus: StatementStatus | null = null;
  let minimumRemaining = 0, statementRemaining = 0;
  if (latest) {
    const newBal = Number(latest.newBalance);
    const min = n(latest.minimumPayment) ?? 0;
    statementRemaining = Math.max(0, r2(newBal - paidSinceClose));
    minimumRemaining = Math.max(0, r2(min - paidSinceClose));
    if (newBal <= 0.005) statementStatus = 'NO_BALANCE';
    else if (statementRemaining <= 0.01) statementStatus = 'PAID_IN_FULL';
    else if (minimumRemaining <= 0.01) statementStatus = 'MINIMUM_MET';
    else statementStatus = latest.dueDate && new Date(latest.dueDate) < today ? 'PAST_DUE' : 'DUE';
  }
  const openStatement = statementStatus === 'DUE' || statementStatus === 'PAST_DUE' || statementStatus === 'MINIMUM_MET';
  const nextDueDate = openStatement && latest?.dueDate ? new Date(latest.dueDate)
    : card.paymentDueDay ? nextDayOfMonth(card.paymentDueDay) : null;
  const nextClosingDate = card.statementClosingDay ? nextDayOfMonth(card.statementClosingDay) : null;

  const limit = n(card.creditLimit) ?? n(latest?.creditLimit);
  const utilization = limit && limit > 0 ? r2((Math.max(balance, 0) / limit) * 100) : null;
  const available = limit != null ? r2(limit - Math.max(balance, 0)) : n(latest?.availableCredit);

  const introActive = card.introApr != null && card.introAprEndDate && new Date(card.introAprEndDate) >= today;
  const apr = introActive ? Number(card.introApr) : n(card.purchaseApr) ?? n(latest?.purchaseApr);
  // Paying the statement in full keeps the grace period: no interest.
  const revolving = statementStatus !== 'PAID_IN_FULL' && statementStatus !== 'NO_BALANCE' && balance > 0;
  const monthlyInterest = revolving && apr != null ? r2((balance * apr) / 100 / 12) : 0;
  const promoEndsInDays = introActive ? Math.round((+new Date(card.introAprEndDate) - +today) / 86400000) : null;

  let nextAnnualFee: Date | null = null;
  if (card.annualFee && Number(card.annualFee) > 0 && card.annualFeeMonth) {
    const m = Number(card.annualFeeMonth) - 1;
    nextAnnualFee = new Date(Date.UTC(today.getUTCFullYear(), m, 1));
    if (nextAnnualFee < new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))) nextAnnualFee = new Date(Date.UTC(today.getUTCFullYear() + 1, m, 1));
  }

  const rewardsBalance = n(card.rewardsBalance) ?? n(latest?.rewardsBalance);
  const cents = n(card.rewardsCentsPerPoint) ?? (card.rewardsType === 'CASHBACK' ? 100 : card.rewardsType ? 1 : null);
  const rewardsValue = rewardsBalance != null && cents != null ? r2((rewardsBalance * cents) / 100) : null;

  const year = today.getUTCFullYear();
  const thisYear = statements.filter((s: any) => new Date(s.closingDate).getUTCFullYear() === year);
  const interestYtd = r2(thisYear.reduce((t: number, s: any) => t + Number(s.interestCharged ?? 0), 0));
  const feesYtd = r2(thisYear.reduce((t: number, s: any) => t + Number(s.feesCharged ?? 0), 0));
  const purchasesYtd = r2(thisYear.reduce((t: number, s: any) => t + Number(s.purchases ?? 0), 0));

  // The minimum a payoff plan must at least cover each month.
  const minimumPayment = n(latest?.minimumPayment) ?? (balance > 0 ? Math.max(25, r2(balance * 0.01 + monthlyInterest)) : 0);

  return {
    balance, balanceSource, limit, available, utilization, apr, introActive: !!introActive, promoEndsInDays, monthlyInterest,
    statementStatus, statementRemaining, minimumRemaining, minimumPayment, paidSinceClose: r2(paidSinceClose),
    latestStatementId: latest?.id ?? null, latestClosingDate: latest?.closingDate ?? null,
    nextDueDate, nextClosingDate, nextAnnualFee, rewardsBalance, rewardsValue, interestYtd, feesYtd, purchasesYtd,
  };
}

/** Totals across every open card. */
export function portfolio(cards: { status: string; position: ReturnType<typeof cardPosition>; annualFee?: unknown }[]) {
  const open = cards.filter(c => c.status !== 'CLOSED');
  const debt = r2(open.reduce((t, c) => t + Math.max(0, c.position.balance), 0));
  const limits = r2(open.reduce((t, c) => t + (c.position.limit ?? 0), 0));
  const in30 = new Date(Date.now() + 30 * 86400000);
  return {
    cards: open.length,
    debt, limits, available: r2(limits - debt),
    utilization: limits > 0 ? r2((debt / limits) * 100) : null,
    monthlyInterest: r2(open.reduce((t, c) => t + c.position.monthlyInterest, 0)),
    minimumsDue30d: r2(open.filter(c => c.position.nextDueDate && c.position.nextDueDate <= in30).reduce((t, c) => t + (c.position.minimumRemaining || 0), 0)),
    pastDue: open.filter(c => c.position.statementStatus === 'PAST_DUE').length,
    promosEnding60d: open.filter(c => c.position.promoEndsInDays != null && c.position.promoEndsInDays <= 60).length,
    annualFees: r2(open.reduce((t, c) => t + Number(c.annualFee ?? 0), 0)),
    rewardsValue: r2(open.reduce((t, c) => t + (c.position.rewardsValue ?? 0), 0)),
    interestYtd: r2(open.reduce((t, c) => t + c.position.interestYtd, 0)),
  };
}
