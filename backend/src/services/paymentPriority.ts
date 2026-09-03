import { db } from '../config/db';
import { normaliseLabel, isFeeLikeCharge } from './chargeAnalytics';

/**
 * Which bills to pay first, and what it costs to be late on each.
 *
 * Operating cost answers "what does this property cost to run". This answers a
 * different question: "I cannot pay everything today — what happens if I let
 * each of these slide?" The two must not be conflated. A late fee is not a
 * cost of running the property, but it is very much a cost of paying late, and
 * deciding what to pay first needs the second number.
 *
 * Every provider is different and none of them are configured here. What a
 * provider does is learned from its own statements: how often penalties have
 * appeared, how large they were, how many days after the due date they landed,
 * and — where the bill prints it — the penalty date and the higher amount
 * payable after it. A provider that has never charged a fee across two years of
 * bills can be deprioritised with some confidence; one that charges every time
 * cannot.
 */

export type FeeBehaviour = 'charges_every_time' | 'charges_sometimes' | 'never_charged' | 'unknown';

export interface AccountPriority {
  accountId: string;
  propertyId: string;
  propertyName: string;
  providerName: string;
  serviceLabel: string | null;
  category: string;

  /** Everything owed right now: this period's charge plus arrears, less payments since. */
  balanceToCurrent: number;
  /** This period's charge alone. */
  currentCharges: number;
  /** Carried from earlier periods. */
  pastDue: number;

  dueDate: string | null;
  /** When a penalty lands, from the bill if stated, else estimated from history. */
  penaltyDate: string | null;
  penaltyDateIsEstimate: boolean;
  daysUntilPenalty: number | null;

  /** What being late has actually cost on this account before. */
  feeBehaviour: FeeBehaviour;
  billsWithFees: number;
  billsSeen: number;
  averageFee: number;
  totalFeesPaid: number;
  /** The fee this specific bill will incur, when the statement or your rule says so. */
  knownNextFee: number | null;
  /** Where the penalty expectation came from, so the UI never overstates it. */
  feeSource: 'your_rule' | 'stated_on_bill' | 'history' | 'none';
  /** From your own rule: when service is cut, and how long that is away. */
  shutoffDate: string | null;
  daysUntilShutoff: number | null;
  /** Typical days between the due date and a fee appearing, from history. */
  typicalGraceDays: number | null;

  /**
   * What paying late costs, per dollar of balance — the ordering that answers
   * "which of these do I pay first". A big balance with no history of fees
   * ranks below a small one that is penalised every month.
   */
  urgencyScore: number;
  reasons: string[];
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isNaN(n) ? 0 : n;
};

const DAY = 24 * 60 * 60 * 1000;
const daysBetween = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY);

/**
 * How this provider has treated late payment, judged from its own statements.
 *
 * Only bills that could have attracted a fee are counted: a statement with no
 * due date tells us nothing about lateness, and neither does one still within
 * its grace period.
 */
function analyseFees(statements: {
  statementDate: Date; dueDate: Date | null; penaltiesFees: unknown; penaltyDate: Date | null;
}[]) {
  const withFee = statements.filter(s => num(s.penaltiesFees) > 0);
  const totalFeesPaid = statements.reduce((t, s) => t + num(s.penaltiesFees), 0);
  const averageFee = withFee.length ? totalFeesPaid / withFee.length : 0;

  // Days between a bill's due date and the next statement that carried a fee —
  // a rough read of how long this provider waits.
  const graceSamples: number[] = [];
  for (let i = 0; i < statements.length - 1; i++) {
    const later = statements[i];
    const earlier = statements[i + 1];
    if (num(later.penaltiesFees) > 0 && earlier.dueDate) {
      graceSamples.push(daysBetween(later.statementDate, earlier.dueDate));
    }
  }
  const typicalGraceDays = graceSamples.length
    ? Math.round(graceSamples.reduce((a, b) => a + b, 0) / graceSamples.length)
    : null;

  let feeBehaviour: FeeBehaviour = 'unknown';
  if (statements.length >= 3) {
    const rate = withFee.length / statements.length;
    feeBehaviour = rate === 0 ? 'never_charged'
      : rate >= 0.75 ? 'charges_every_time'
      : 'charges_sometimes';
  } else if (withFee.length > 0) {
    feeBehaviour = 'charges_sometimes';
  }

  return {
    feeBehaviour,
    billsWithFees: withFee.length,
    billsSeen: statements.length,
    averageFee,
    totalFeesPaid,
    typicalGraceDays,
  };
}

export async function getPaymentPriorities(userId: string, propertyId?: string): Promise<AccountPriority[]> {
  const accounts = await db.utilityAccount.findMany({
    where: {
      isActive: true,
      property: propertyId ? { id: propertyId, userId } : { userId },
    },
    include: {
      property: { select: { id: true, address: true, nickname: true } },
      statements: {
        orderBy: { statementDate: 'desc' },
        take: 36,
        select: {
          id: true, statementDate: true, dueDate: true, amountDue: true,
          pastDueCarried: true, penaltiesFees: true, amountPaid: true,
          penaltyDate: true, amountAfterDueDate: true, isDownPayment: true,
        },
      },
      payments: {
        orderBy: { paymentDate: 'desc' }, take: 24,
        select: { amount: true, paymentDate: true },
      },
    },
  });

  const now = new Date();
  const results: AccountPriority[] = [];

  for (const account of accounts) {
    const statements = account.statements.filter(s => !s.isDownPayment);
    const latest = statements[0];
    if (!latest) continue;

    const currentCharges = num(latest.amountDue);
    const pastDue = num(latest.pastDueCarried);

    // Payments recorded after the statement reduce what is actually owed. The
    // statement is a snapshot; payments since are the correction.
    const paidSince = account.payments
      .filter(p => p.paymentDate > latest.statementDate)
      .reduce((t, p) => t + num(p.amount), 0);
    const statementPaid = num(latest.amountPaid);

    const balanceToCurrent = Math.max(0, currentCharges + pastDue - paidSince - statementPaid);

    const fees = analyseFees(statements);

    // Precedence: your own rule, then what the bill states, then history. You
    // know the policy; the bill reports this instance of it; history is only
    // evidence. Nothing inferred should ever override something known.
    let penaltyDate: Date | null = null;
    let penaltyDateIsEstimate = false;

    if (account.graceDays != null && latest.dueDate) {
      penaltyDate = new Date(latest.dueDate.getTime() + account.graceDays * DAY);
    } else if (latest.penaltyDate) {
      penaltyDate = latest.penaltyDate;
    }

    if (!penaltyDate && latest.dueDate) {
      // No stated penalty date. If this provider has charged fees before, the
      // due date is the best available proxy; the grace observed in history
      // shifts it. Marked as an estimate so the UI never presents it as fact.
      const grace = fees.typicalGraceDays != null && fees.typicalGraceDays > 0
        ? Math.min(fees.typicalGraceDays, 45)
        : 0;
      penaltyDate = new Date(latest.dueDate.getTime() + grace * DAY);
      penaltyDateIsEstimate = true;
    }

    // Your rule first: a fixed fee, a percentage of the balance, or both.
    let knownNextFee: number | null = null;
    let feeSource: AccountPriority['feeSource'] = 'none';
    if (account.lateFeeFixed != null || account.lateFeePercent != null) {
      knownNextFee = num(account.lateFeeFixed)
        + (num(account.lateFeePercent) / 100) * (currentCharges + pastDue);
      feeSource = 'your_rule';
    } else if (latest.amountAfterDueDate != null) {
      knownNextFee = Math.max(0, num(latest.amountAfterDueDate) - currentCharges - pastDue);
      feeSource = 'stated_on_bill';
    } else if (fees.feeBehaviour !== 'never_charged' && fees.feeBehaviour !== 'unknown') {
      feeSource = 'history';
    }

    // Shutoff is never inferred: it appears on a disconnection notice, not a
    // bill, so it is reported only when you have recorded the threshold.
    let shutoffDate: Date | null = null;
    if (account.shutoffAfterDays != null && latest.dueDate && balanceToCurrent > 0) {
      shutoffDate = new Date(latest.dueDate.getTime() + account.shutoffAfterDays * DAY);
    }
    const daysUntilShutoff = shutoffDate ? daysBetween(shutoffDate, now) : null;

    const daysUntilPenalty = penaltyDate ? daysBetween(penaltyDate, now) : null;

    // Ordering. The question is not "which is biggest" but "which costs most
    // to delay", so the score is the expected fee weighted by how soon it
    // lands. An account with nothing owed cannot be urgent whatever its
    // history.
    const expectedFee = knownNextFee ?? (
      fees.feeBehaviour === 'charges_every_time' ? fees.averageFee
        : fees.feeBehaviour === 'charges_sometimes' ? fees.averageFee * (fees.billsWithFees / Math.max(fees.billsSeen, 1))
        : 0
    );
    let urgencyScore = 0;
    const reasons: string[] = [];

    if (balanceToCurrent > 0) {
      const proximity = daysUntilPenalty == null ? 0.5
        : daysUntilPenalty < 0 ? 2      // already past the penalty date
        : daysUntilPenalty <= 7 ? 1.5
        : daysUntilPenalty <= 21 ? 1
        : 0.4;
      urgencyScore = expectedFee * proximity;

      // Losing service is categorically worse than a fee, so an account
      // approaching shutoff sorts above every fee-driven one regardless of
      // amounts. Scaled by nearness rather than made a flat override, so two
      // accounts facing shutoff still order sensibly between themselves.
      if (daysUntilShutoff != null) {
        urgencyScore += daysUntilShutoff < 0 ? 100000
          : daysUntilShutoff <= 7 ? 50000
          : daysUntilShutoff <= 30 ? 10000
          : 1000;
        reasons.unshift(daysUntilShutoff < 0
          ? `Past your recorded shutoff threshold by ${Math.abs(daysUntilShutoff)} day(s)`
          : `Service is cut in ${daysUntilShutoff} day(s) by your recorded rule`);
      }

      if (daysUntilPenalty != null && daysUntilPenalty < 0) {
        reasons.push(`Past the penalty date by ${Math.abs(daysUntilPenalty)} day(s)`);
      } else if (daysUntilPenalty != null) {
        reasons.push(`${daysUntilPenalty} day(s) until a penalty applies${penaltyDateIsEstimate ? ' (estimated)' : ''}`);
      }
      if (knownNextFee != null && knownNextFee > 0) {
        reasons.push(feeSource === 'your_rule'
          ? `Your rule for this account: a late fee of ${knownNextFee.toFixed(2)}`
          : `The bill states a late amount ${knownNextFee.toFixed(2)} higher`);
      } else if (fees.feeBehaviour === 'charges_every_time') {
        reasons.push(`Charged a fee on ${fees.billsWithFees} of ${fees.billsSeen} bills, averaging ${fees.averageFee.toFixed(2)}`);
      } else if (fees.feeBehaviour === 'never_charged') {
        reasons.push(`No fee on any of the last ${fees.billsSeen} bills — this one can wait if something else cannot`);
      } else if (fees.feeBehaviour === 'charges_sometimes') {
        reasons.push(`Charged a fee on ${fees.billsWithFees} of ${fees.billsSeen} bills`);
      } else {
        reasons.push('Not enough billing history to know whether this provider charges late fees');
      }
      if (pastDue > 0) reasons.push(`Already carrying ${pastDue.toFixed(2)} from earlier periods`);
    } else {
      reasons.push('Nothing owed');
    }

    results.push({
      accountId: account.id,
      propertyId: account.property.id,
      propertyName: account.property.nickname || account.property.address,
      providerName: account.providerName,
      serviceLabel: account.serviceLabel,
      category: account.category,
      balanceToCurrent,
      currentCharges,
      pastDue,
      dueDate: latest.dueDate?.toISOString() ?? null,
      penaltyDate: penaltyDate?.toISOString() ?? null,
      penaltyDateIsEstimate,
      daysUntilPenalty,
      ...fees,
      knownNextFee,
      feeSource,
      shutoffDate: shutoffDate?.toISOString() ?? null,
      daysUntilShutoff,
      urgencyScore,
      reasons,
    });
  }

  return results.sort((a, b) => b.urgencyScore - a.urgencyScore || b.balanceToCurrent - a.balanceToCurrent);
}

export interface FeeSummary {
  totalFeesPaid: number;
  billsWithFees: number;
  byProvider: {
    providerName: string;
    propertyName: string;
    accountId: string;
    total: number;
    count: number;
    behaviour: FeeBehaviour;
  }[];
  byMonth: { month: string; total: number }[];
}

/**
 * Every fee charged across the portfolio, and by whom.
 *
 * Fees are individually small and collectively not — the point of totalling
 * them in one place is that nobody notices $5 on a bill twelve times a year
 * across twenty accounts.
 */
export async function getFeeSummary(userId: string, since?: Date): Promise<FeeSummary> {
  // Not filtered to penaltiesFees > 0: fees also hide inside the charge
  // breakdown — a contamination charge on a trash bill is a penalty, printed
  // as a line item rather than in the late-fee field — so every statement is
  // read and the fee content of each is worked out below.
  const statements = await db.statement.findMany({
    where: {
      utilityAccount: { property: { userId } },
      ...(since ? { statementDate: { gte: since } } : {}),
    },
    select: {
      statementDate: true, penaltiesFees: true, rawDataJson: true,
      utilityAccount: {
        select: {
          id: true, providerName: true, serviceLabel: true,
          property: { select: { address: true, nickname: true } },
        },
      },
    },
    orderBy: { statementDate: 'desc' },
  });

  const byProviderMap = new Map<string, FeeSummary['byProvider'][number]>();
  const byMonthMap = new Map<string, number>();
  let totalFeesPaid = 0;

  for (const s of statements) {
    // penaltiesFees carries the extracted late fee; the breakdown can carry
    // further penalties printed as line items. Late-fee lines in the breakdown
    // are excluded there because they are already counted here — everything
    // else fee-like (contamination, returned payments, reconnection) adds on.
    const breakdown = ((s.rawDataJson as Record<string, unknown> | null)?.chargeBreakdown ?? null) as Record<string, number> | null;
    let breakdownFees = 0;
    if (breakdown) {
      for (const [rawLabel, value] of Object.entries(breakdown)) {
        const label = normaliseLabel(rawLabel);
        if (isFeeLikeCharge(label) && !/late\s*fee/i.test(label)) breakdownFees += num(value);
      }
    }
    const fee = num(s.penaltiesFees) + breakdownFees;
    if (fee <= 0) continue;
    totalFeesPaid += fee;

    const a = s.utilityAccount;
    const key = a.id;
    const existing = byProviderMap.get(key);
    if (existing) {
      existing.total += fee;
      existing.count += 1;
    } else {
      byProviderMap.set(key, {
        accountId: a.id,
        providerName: a.serviceLabel ? `${a.providerName} — ${a.serviceLabel}` : a.providerName,
        propertyName: a.property.nickname || a.property.address,
        total: fee,
        count: 1,
        behaviour: 'unknown',
      });
    }

    const month = s.statementDate.toISOString().slice(0, 7);
    byMonthMap.set(month, (byMonthMap.get(month) ?? 0) + fee);
  }

  return {
    totalFeesPaid,
    billsWithFees: statements.length,
    byProvider: [...byProviderMap.values()].sort((a, b) => b.total - a.total),
    byMonth: [...byMonthMap.entries()]
      .map(([month, total]) => ({ month, total }))
      .sort((a, b) => b.month.localeCompare(a.month)),
  };
}
