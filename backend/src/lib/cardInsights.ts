/**
 * What a household's cards say about their credit and cost, as insights with
 * one action each:
 *
 * - PAST_DUE        a minimum unpaid past its due date; days until it is reported 30 days late
 * - LATE_FEES       late fees in the last year (ask for a courtesy waiver; autopay the minimum)
 * - INTEREST        interest paid in the last year
 * - UTILIZATION     a card over 30% of its limit (or the total over 30%), and what brings it under
 * - PROMO_PACE      a deferred-interest balance that won't be paid off by its date at the current pace
 * - MIN_VS_INTEREST a minimum that barely covers the interest
 * - PAYDOWN_ORDER   which card to put extra money on first
 *
 * And a credit snapshot: the factors a score is built from that Sollux can see
 * (payment history and utilization) — not a score, which only the bureaus have.
 *
 * Pure: the route gathers each card's position, health and newest statement.
 */
import type { CardHealth } from './cardHealth';

export type CardInsightKind = 'PAST_DUE' | 'LATE_FEES' | 'FEE_WAIVER' | 'INTEREST' | 'APR_REDUCTION' | 'BALANCE_TRANSFER' | 'PENALTY_APR' | 'UTILIZATION' | 'PROMO_PACE' | 'MIN_VS_INTEREST' | 'PAYDOWN_ORDER';
export interface CardInsight {
  kind: CardInsightKind; severity: 'ALERT' | 'WARNING' | 'INFO';
  cardId: string | null; cardName: string | null;
  title: string; detail: string; action: string;
  /** Dollars a year at stake, when there is a figure. */
  perYear: number | null;
  /** What to say when calling the issuer. */
  script?: string | null;
}
export interface InsightCard {
  id: string; name: string; status: string; autopay: string; phone?: string | null;
  penaltyApr?: number | null; annualFee?: number | null;
  /** The card's standard purchase rate (the position's apr is the promotional one while a promotion runs). */
  purchaseApr?: number | null;
  position: { balance: number; limit: number | null; utilization: number | null; apr: number | null; introActive: boolean; monthlyInterest: number; minimumPayment: number; statementStatus: string | null; minimumRemaining: number; nextDueDate: Date | string | null };
  health: CardHealth;
  promotions: { balance: number; payBy: string }[];
  /** Paid in the last 90 days, net of returned payments. */
  paid90: number;
  minPayoffMonths: number | null;
}
export interface CreditSnapshot {
  utilization: number | null; debt: number; limits: number;
  onTime12: number; late12: number; worstDaysLate12: number; cardsPastDue: number; cardsOver30: number;
  /** Lates in the last 12 months reported to the bureaus (30+ days past due on a statement date). */
  reported12: number;
  feesAndInterest12: number;
  /** Plain-words reading of the two factors Sollux can see. */
  paymentHistory: 'GOOD' | 'FAIR' | 'POOR' | 'UNKNOWN'; utilizationBand: 'EXCELLENT' | 'GOOD' | 'HIGH' | 'VERY_HIGH' | 'UNKNOWN';
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const money2 = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const r0 = (n: number) => Math.round(n);
const monthsBetween = (from: Date, to: string) => {
  const t = new Date(`${to}T00:00:00Z`);
  return Math.max(1, (t.getUTCFullYear() - from.getUTCFullYear()) * 12 + (t.getUTCMonth() - from.getUTCMonth()) + (t.getUTCDate() >= from.getUTCDate() ? 0 : -1) + 1);
};

export function cardInsights(cards: InsightCard[], today: Date = new Date()): { insights: CardInsight[]; snapshot: CreditSnapshot } {
  const open = cards.filter(c => c.status !== 'CLOSED');
  const out: CardInsight[] = [];
  const todayIso = today.toISOString().slice(0, 10);

  for (const c of open) {
    const p = c.position, h = c.health;
    const call = c.phone ? ` (${c.phone})` : '';

    if (h.daysPastDue > 0) {
      const to30 = 30 - h.daysPastDue;
      out.push({
        kind: 'PAST_DUE', severity: 'ALERT', cardId: c.id, cardName: c.name, perYear: null,
        title: to30 > 0 ? `${c.name} is ${h.daysPastDue} day${h.daysPastDue === 1 ? '' : 's'} past due` : `${c.name} is ${h.daysPastDue} days past due — likely reported late`,
        detail: to30 > 0
          ? `${money2(p.minimumRemaining)} minimum still owed. Issuers report a payment to the credit bureaus once it is 30 days past due — ${to30} day${to30 === 1 ? '' : 's'} from now — and it stays on the report for 7 years.`
          : `${money2(p.minimumRemaining)} minimum still owed. At 30 days past due issuers report it to the bureaus; at 60 and 90 days it is reported again, worse each time.`,
        action: to30 > 0 ? `Pay at least ${money2(p.minimumRemaining)} today. Then call${call} and ask them to waive the late fee.` : `Pay the past-due amount now to stop it reaching the next 30-day mark, and ask the issuer${call} for a goodwill adjustment once it is current.`,
      });
    }

    const yearAgo = new Date(today.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
    const waived = h.lateEvents.filter(e => e.waived && e.date >= yearAgo).reduce((t, e) => t + e.fee, 0);
    const lateNet = Math.max(0, h.last12.lateFees - waived);
    if (lateNet > 0.005 || h.last12.late > 0) {
      out.push({
        kind: 'LATE_FEES', severity: 'WARNING', cardId: c.id, cardName: c.name, perYear: lateNet > 0 ? Math.round(lateNet * 100) / 100 : null,
        title: `Late payments on ${c.name}`,
        detail: `${h.last12.late} late payment${h.last12.late === 1 ? '' : 's'} in the last 12 months${h.last12.lateFees ? `, ${money2(h.last12.lateFees)} in late fees` : ''}${waived ? ` (${lateNet > 0 ? `${money2(waived)}` : 'all'} refunded)` : ''}${h.last12.reported ? `; ${h.last12.reported} ${h.last12.reported === 1 ? 'was' : 'were'} still 30+ days past due on a statement date, which issuers report to the credit bureaus` : '; none was 30 days past due on a statement date, so none was reported to the credit bureaus'}.`,
        action: `${lateNet > 0 ? `Call${call} and ask for a one-time courtesy waiver of the late fee — most issuers give one. ` : ''}${c.autopay === 'NONE' ? 'Turn on autopay for at least the minimum so a due date is never missed.' : 'Autopay is on — check it covers the minimum and the account it draws from has the money.'}`,
        script: lateNet > 0 ? `"Hi, I was charged a ${money2(h.last12.lateFees)} late fee. I've paid and I'm setting up autopay so it won't happen again. Could you waive it as a one-time courtesy?" If they say no, ask once more for a partial credit, then thank them.` : null,
      });
    }

    // Other fees — a returned-payment charge, an annual fee — can be asked back too.
    const other = h.last12.otherFees;
    const otherNet = Math.max(0, other - Math.max(0, h.last12.refunds - waived));
    if (otherNet > 0.005) {
      out.push({
        kind: 'FEE_WAIVER', severity: 'INFO', cardId: c.id, cardName: c.name, perYear: Math.round(otherNet * 100) / 100,
        title: `Ask ${c.name} to refund ${money2(otherNet)} in fees`,
        detail: `Fees other than late fees in the last 12 months (a returned-payment charge, an annual or over-limit fee). Issuers refund these on request more often than not, especially for a customer who pays.`,
        action: `Call${call} and ask for the fees to be reversed as a courtesy.`,
        script: `"I see ${money2(otherNet)} in fees on my account this year. I've been paying on time since — could you reverse them as a courtesy?"`,
      });
    }
    if (Number(c.annualFee ?? 0) > 0) {
      out.push({
        kind: 'FEE_WAIVER', severity: 'INFO', cardId: c.id, cardName: c.name, perYear: Number(c.annualFee),
        title: `${c.name} charges a ${money2(Number(c.annualFee))} annual fee`,
        detail: 'Issuers often waive the fee or offer a credit to keep a customer, or switch the card to a no-fee version without closing it (which keeps its age and limit on your report).',
        action: `Before the fee posts, call${call} and ask for a retention offer or a product change.`,
        script: '"My annual fee is coming up and I\'m deciding whether to keep the card. Are there any retention offers, or can I switch to a no-annual-fee card and keep my account?"',
      });
    }

    if (h.last12.interest > 0.005) {
      out.push({
        kind: 'INTEREST', severity: 'INFO', cardId: c.id, cardName: c.name, perYear: Math.round(h.last12.interest * 100) / 100,
        title: `${money(h.last12.interest)} of interest on ${c.name}`,
        detail: `Interest charged over the last 12 months${p.apr != null ? ` at ${p.apr}% APR` : ''}; about ${money2(p.monthlyInterest)} this month on a ${money2(p.balance)} balance.`,
        action: 'Paying the statement balance in full each month stops interest on new purchases. A 0% balance-transfer card, or paying this card first, cuts it.',
      });
    }

    // Carrying a balance at a high rate: ask for a lower one; a 0% transfer can be cheaper still.
    if (p.balance > 200 && p.apr != null && !p.introActive && p.apr >= 18 && h.last12.interest > 0.005) {
      const cut = Math.round(p.balance * 0.05);   // what a 5-point reduction saves in a year
      out.push({
        kind: 'APR_REDUCTION', severity: 'INFO', cardId: c.id, cardName: c.name, perYear: cut,
        title: `Ask ${c.name} for a lower rate than ${p.apr}%`,
        detail: `On a ${money2(p.balance)} balance, each point off the APR saves about ${money2(p.balance / 100)} a year; a 5-point cut about ${money(cut)}. Issuers lower rates for customers who ask, especially with on-time payments${h.last12.late ? '' : ' like yours'}.`,
        action: `Call${call} and ask for an APR reduction. If they say no, ask what it would take, and ask again in 3–6 months.`,
        script: `"I've been a cardholder for a while and I'm paying down my balance. I'm getting offers with lower rates — can you lower my APR from ${p.apr}%?"`,
      });
      const fee = p.balance * 0.03, saved = p.monthlyInterest * 12 - fee;
      if (saved > 100) {
        out.push({
          kind: 'BALANCE_TRANSFER', severity: 'INFO', cardId: c.id, cardName: c.name, perYear: Math.round(saved),
          title: `A 0% balance transfer could save about ${money(saved)} on ${c.name}`,
          detail: `About ${money2(p.monthlyInterest * 12)} a year of interest at ${p.apr}%; a 12–21 month 0% balance-transfer card typically charges a 3–5% fee (about ${money2(fee)} at 3%).`,
          action: 'Only if you can pay it off within the 0% period and avoid new charges on it. Applying is a hard inquiry on your report.',
        });
      }
    }
    if (c.penaltyApr != null && p.apr != null && !p.introActive && Math.abs(p.apr - c.penaltyApr) < 0.01) {
      out.push({
        kind: 'PENALTY_APR', severity: 'WARNING', cardId: c.id, cardName: c.name, perYear: p.balance > 0 ? Math.round(p.balance * 0.06) : null,
        title: `${c.name} is at its penalty rate of ${p.apr}%`,
        detail: 'A penalty APR follows a late payment. By law it must be reviewed after six on-time payments, and you can ask sooner.',
        action: `After six on-time payments in a row${h.onTimeStreak ? ` (you have ${h.onTimeStreak})` : ''}, call${call} and ask for the standard rate back.`,
        script: '"I\'ve made my last payments on time. Can you take my account off the penalty rate and back to the standard APR?"',
      });
    }

    if (p.utilization != null && p.utilization > 30 && p.limit) {
      const to30 = p.balance - 0.3 * p.limit;
      out.push({
        kind: 'UTILIZATION', severity: p.utilization >= 90 ? 'WARNING' : 'INFO', cardId: c.id, cardName: c.name, perYear: null,
        title: `${c.name} is at ${Math.round(p.utilization)}% of its limit`,
        detail: `${money2(p.balance)} of a ${money2(p.limit)} limit. Scores weigh each card's utilization as well as the total; under 30% helps, under 10% is best.${p.utilization >= 90 ? ' Near the limit, a charge can be declined or bring an over-limit fee.' : ''}`,
        action: `Paying ${money2(to30)} brings it under 30%. Paying before the statement closes lowers what gets reported, since issuers report the closing balance.`,
      });
    }

    for (const pr of c.promotions.filter(x => x.payBy >= todayIso && x.balance > 0)) {
      const months = monthsBetween(today, pr.payBy);
      const needed = pr.balance / months;
      const pace = c.paid90 / 3;
      if (pace + 1 < needed) {
        const short = Math.max(0, pr.balance - pace * months);
        out.push({
          kind: 'PROMO_PACE', severity: months <= 3 ? 'ALERT' : 'WARNING', cardId: c.id, cardName: c.name, perYear: null,
          title: `${money2(pr.balance)} promotional balance on ${c.name} won't be paid off by ${pr.payBy}`,
          detail: `It must be paid in full by ${pr.payBy} (${months} month${months === 1 ? '' : 's'}) or interest is charged back to the purchase date${c.purchaseApr ? ` at ${c.purchaseApr}%` : ''}. Paying about ${money2(pace)} a month leaves roughly ${money2(short)} unpaid.`,
          action: `Pay about ${money2(Math.ceil(needed))} a month to clear it in time — more than the ${money2(p.minimumPayment)} minimum, which is not set to pay it off.`,
        });
      }
    }

    if (p.monthlyInterest > 0 && p.minimumPayment > 0 && p.minimumPayment <= p.monthlyInterest * 1.25) {
      out.push({
        kind: 'MIN_VS_INTEREST', severity: 'WARNING', cardId: c.id, cardName: c.name, perYear: null,
        title: `The minimum on ${c.name} barely covers its interest`,
        detail: `The ${money2(p.minimumPayment)} minimum against about ${money2(p.monthlyInterest)} of interest a month pays down almost nothing${c.minPayoffMonths ? `: at the minimum it takes about ${Math.round(c.minPayoffMonths / 12)} years to pay off` : ''}.`,
        action: `Pay at least ${money2(Math.ceil(p.monthlyInterest + p.balance * 0.02))} a month to bring the balance down.`,
      });
    }
  }

  // Which card to pay first: the highest rate, with a promotion that is about to end ahead of it.
  const carrying = open.filter(c => c.position.balance > 0.005 && c.position.statementStatus !== 'PAID_IN_FULL');
  if (carrying.length >= 2) {
    const rank = (c: InsightCard) => {
      const soon = c.promotions.some(x => x.payBy >= todayIso && monthsBetween(today, x.payBy) <= 3 && x.balance > 0);
      return soon ? 1000 : c.position.introActive ? -1 : c.position.apr ?? 0;
    };
    const order = [...carrying].sort((a, b) => rank(b) - rank(a));
    const top = order[0];
    out.push({
      kind: 'PAYDOWN_ORDER', severity: 'INFO', cardId: top.id, cardName: top.name, perYear: r0(top.position.monthlyInterest * 12) || null,
      title: `Pay ${top.name} down first`,
      detail: `Order to put extra money on: ${order.map(c => `${c.name} (${c.position.introActive ? 'promo rate' : c.position.apr != null ? `${c.position.apr}%` : 'rate unknown'}, ${money2(c.position.balance)})`).join(' → ')}. Highest rate first saves the most interest; a promotion ending soon goes ahead of it.`,
      action: `Pay the minimum on every card, and everything extra on ${top.name}. When it is paid off, move that payment to the next one.`,
    });
  }

  // The credit snapshot.
  const debt = open.reduce((t, c) => t + Math.max(0, c.position.balance), 0);
  const limits = open.reduce((t, c) => t + (c.position.limit ?? 0), 0);
  const util = limits > 0 ? Math.round((debt / limits) * 1000) / 10 : null;
  if (util != null && util > 30 && !out.some(i => i.kind === 'UTILIZATION' && i.cardId == null)) {
    out.push({
      kind: 'UTILIZATION', severity: util >= 75 ? 'WARNING' : 'INFO', cardId: null, cardName: null, perYear: null,
      title: `Overall card utilization is ${util}%`,
      detail: `${money2(debt)} owed across ${money2(limits)} of limits. Utilization is about a third of a credit score; under 30% helps, under 10% is best.${open.some(c => c.position.limit == null && c.position.balance > 0) ? ' Some cards have no limit on file, which makes this read high — add their limits.' : ''}`,
      action: `Paying ${money2(debt - 0.3 * limits)} brings the total under 30%.`,
    });
  }
  const onTime12 = open.reduce((t, c) => t + c.health.last12.onTime, 0);
  const late12 = open.reduce((t, c) => t + c.health.last12.late, 0);
  const worst = Math.max(0, ...open.map(c => c.health.last12.worstDaysLate), ...open.map(c => c.health.daysPastDue));
  const reported12 = open.reduce((t, c) => t + c.health.last12.reported, 0);
  const snapshot: CreditSnapshot = {
    utilization: util, debt: Math.round(debt * 100) / 100, limits: Math.round(limits * 100) / 100,
    onTime12, late12, worstDaysLate12: worst, reported12,
    cardsPastDue: open.filter(c => c.health.daysPastDue > 0).length,
    cardsOver30: open.filter(c => (c.position.utilization ?? 0) > 30).length,
    feesAndInterest12: Math.round(open.reduce((t, c) => t + c.health.last12.net, 0) * 100) / 100,
    // Poor is a late on the credit report (or one about to be): a payment made late but before it was 30 days past due on a statement date is not.
    paymentHistory: onTime12 + late12 === 0 ? 'UNKNOWN' : reported12 > 0 || open.some(c => c.health.daysPastDue >= 30) ? 'POOR' : late12 > 0 ? 'FAIR' : 'GOOD',
    utilizationBand: util == null ? 'UNKNOWN' : util < 10 ? 'EXCELLENT' : util < 30 ? 'GOOD' : util < 50 ? 'HIGH' : 'VERY_HIGH',
  };
  const rankSev = { ALERT: 0, WARNING: 1, INFO: 2 } as const;
  out.sort((a, b) => rankSev[a.severity] - rankSev[b.severity] || (b.perYear ?? 0) - (a.perYear ?? 0));
  return { insights: out, snapshot };
}
