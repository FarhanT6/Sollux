import { monthlyEquivalent, type CadenceAccount } from './cadence';
import { operatingCost, type OperatingCostOptions } from './operatingCost';
import { monthKey as rawMonthKey } from './date';

/** monthKey, with the null case collapsed — a statement always has a date. */
const monthKey = (d: string | Date): string => rawMonthKey(d) ?? '';

/**
 * Which month a bill's cost belongs to.
 *
 * The issue date is the wrong answer. An IID bill issued 30 December covers
 * 28 October to 25 November — that is November's electricity, and filing it
 * under December both misstates December and leaves November looking empty.
 * A drifting cycle also puts two bills in one calendar month, so issue month
 * is not even unique.
 *
 * The period's end is what the bill was for. Only when a bill states no period
 * does the issue date stand in.
 */
const billingMonth = (s: { statementDate: string; billingPeriodEnd?: string | null }): string =>
  monthKey(s.billingPeriodEnd || s.statementDate);

/**
 * What a property costs per month, and where the figure comes from.
 *
 * The previous total summed each account's *latest* statement plus its carried
 * past due. Three things were wrong with that. Accounts bill on different
 * cycles, so "latest" meant a different month for each and the total belonged
 * to no month at all. Past due is arrears — money owed from earlier periods,
 * not what this month cost. And a single month is not what anyone means by
 * "monthly" for a property whose bills swing seasonally.
 *
 * So two numbers, and the working shown for both:
 *   - current: the most recent month that has bills, as billed
 *   - average: mean monthly cost across the months with data
 */

export interface SpendAccount extends CadenceAccount {
  id: string;
  providerName: string;
  serviceLabel?: string | null;
  category: string;
  isActive?: boolean;
  statements?: SpendStatement[];
}

export interface SpendStatement {
  id: string;
  statementDate: string;
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
  amountDue?: number | string | null;
  penaltiesFees?: number | string | null;
  paymentPlanAmount?: number | string | null;
  isDownPayment?: boolean;
}

export interface SpendLine {
  accountId: string;
  label: string;
  category: string;
  /** What this account contributed to the figure. */
  amount: number;
  /** Where that came from, for the breakdown: a month, or an estimate. */
  basis: string;
}

export interface MonthlySpend {
  current: number;
  currentMonthKey: string | null;
  currentLines: SpendLine[];
  average: number;
  averageMonths: number;
  averageLines: SpendLine[];
}

const accountLabel = (a: SpendAccount) =>
  a.serviceLabel ? `${a.providerName} — ${a.serviceLabel}` : a.providerName;

/** Statements that represent a period's cost: deposits are not. */
const billing = (a: SpendAccount): SpendStatement[] =>
  (a.statements ?? []).filter(s => !s.isDownPayment);

/**
 * Build both figures from the accounts a property holds.
 *
 * `months` bounds the average — a year by default, so a seasonal swing
 * averages out without a rate change from three years ago dragging on it.
 */
export function computeMonthlySpend(
  accounts: SpendAccount[],
  opts: OperatingCostOptions = {},
  months = 12,
): MonthlySpend {
  const active = accounts.filter(a => a.isActive !== false);

  // The month the figure describes: the most recent one any account billed in.
  // Taken from the data rather than from today's date, so a property whose
  // bills arrive mid-month doesn't read as $0 for the first two weeks.
  let currentMonthKey: string | null = null;
  for (const a of active) {
    for (const s of billing(a)) {
      const key = billingMonth(s);
      if (!currentMonthKey || key > currentMonthKey) currentMonthKey = key;
    }
  }

  const currentLines: SpendLine[] = [];
  for (const a of active) {
    const statements = billing(a);
    const inMonth = currentMonthKey
      ? statements.find(s => billingMonth(s) === currentMonthKey)
      : undefined;

    if (inMonth) {
      currentLines.push({
        accountId: a.id,
        label: accountLabel(a),
        category: a.category,
        // Spread by cadence: an annual premium billed this month is not this
        // month's cost in full.
        amount: monthlyEquivalent(a, operatingCost(inMonth, opts)),
        basis: currentMonthKey!,
      });
      continue;
    }

    // No bill in that month. For an account that doesn't bill monthly this is
    // expected, and its monthly share still applies — an annual policy costs
    // something every month, it just isn't invoiced every month.
    const spread = monthlyEquivalent(a, statements[0] ? operatingCost(statements[0], opts) : null);
    if (spread > 0) {
      currentLines.push({
        accountId: a.id,
        label: accountLabel(a),
        category: a.category,
        amount: spread,
        basis: statements[0] ? `spread from ${billingMonth(statements[0])}` : 'expected amount',
      });
    } else {
      currentLines.push({
        accountId: a.id, label: accountLabel(a), category: a.category,
        amount: 0, basis: 'no bill',
      });
    }
  }

  // The average: every billing month within the window, divided by how many
  // months actually carried a bill. Dividing by the window instead would
  // understate a property whose history is shorter than the window.
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffKey = monthKey(cutoff.toISOString());

  const monthsSeen = new Set<string>();
  const averageLines: SpendLine[] = [];

  for (const a of active) {
    const inWindow = billing(a).filter(s => billingMonth(s) >= cutoffKey);
    if (inWindow.length === 0) continue;

    let total = 0;
    for (const s of inWindow) {
      monthsSeen.add(billingMonth(s));
      total += operatingCost(s, opts);
    }
    averageLines.push({
      accountId: a.id,
      label: accountLabel(a),
      category: a.category,
      amount: total,
      basis: `${inWindow.length} bill${inWindow.length === 1 ? '' : 's'}`,
    });
  }

  const averageMonths = Math.max(monthsSeen.size, 1);
  const averageTotal = averageLines.reduce((s, l) => s + l.amount, 0);

  return {
    current: currentLines.reduce((s, l) => s + l.amount, 0),
    currentMonthKey,
    currentLines: currentLines.sort((a, b) => b.amount - a.amount),
    average: averageTotal / averageMonths,
    averageMonths,
    // Each account's own monthly average, so the lines sum to the headline.
    averageLines: averageLines
      .map(l => ({ ...l, amount: l.amount / averageMonths }))
      .sort((a, b) => b.amount - a.amount),
  };
}

export interface SpendProperty {
  id: string;
  address: string;
  nickname?: string | null;
  utilityAccounts?: SpendAccount[];
}

export interface PortfolioSpendLine {
  propertyId: string;
  label: string;
  current: number;
  average: number;
  /** Which month `current` came from — properties bill on their own cycles. */
  monthKey: string | null;
  accountCount: number;
}

export interface PortfolioSpend {
  current: number;
  average: number;
  /** How many properties contributed anything, for an honest denominator. */
  propertiesWithData: number;
  lines: PortfolioSpendLine[];
}

/**
 * The same two figures across every property.
 *
 * Summed from each property's own computation rather than pooling all
 * statements: properties bill on different cycles, and a portfolio total that
 * picked one month for everyone would drop whichever properties happen to bill
 * later. Each property contributes its own most recent month, which is what
 * "what does the portfolio cost right now" actually means.
 */
export function computePortfolioSpend(
  properties: SpendProperty[],
  opts: OperatingCostOptions = {},
  months = 12,
): PortfolioSpend {
  const lines: PortfolioSpendLine[] = [];

  for (const p of properties) {
    const accounts = p.utilityAccounts ?? [];
    if (accounts.length === 0) continue;

    const spend = computeMonthlySpend(accounts, opts, months);
    lines.push({
      propertyId: p.id,
      label: p.nickname || p.address,
      current: spend.current,
      average: spend.average,
      monthKey: spend.currentMonthKey,
      accountCount: accounts.length,
    });
  }

  return {
    current: lines.reduce((s, l) => s + l.current, 0),
    average: lines.reduce((s, l) => s + l.average, 0),
    propertiesWithData: lines.filter(l => l.current > 0 || l.average > 0).length,
    lines: lines.sort((a, b) => b.average - a.average),
  };
}
