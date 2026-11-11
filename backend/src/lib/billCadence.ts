/**
 * How long an account can go without a new bill before that is a problem:
 * its billing cycle plus some slack for a late statement. Null for cadences
 * where silence is normal (annual, per term, one-time). One rule for the
 * Gmail coverage report and the portal sync, so they never disagree.
 */
export function overdueAfterDays(cadence: string | null | undefined): number | null {
  return cadence === 'BIMONTHLY' ? 75 : cadence === 'QUARTERLY' ? 110 : cadence === 'MONTHLY' ? 45 : null;
}

/** Days between bills: when the next one is expected. Unknown or once-a-term cadences fall back to monthly checks. */
export function billCycleDays(cadence: string | null | undefined, termMonths?: number | null): number {
  // A policy billed once a term (6 or 12 months) was checked monthly.
  if (cadence === 'TERM' && termMonths && termMonths > 0) return Math.round(termMonths * 30.44);
  return cadence === 'BIMONTHLY' ? 60 : cadence === 'QUARTERLY' ? 91 : cadence === 'SEMI_ANNUAL' ? 182 : cadence === 'ANNUAL' ? 365 : 30;
}

/**
 * How many days an account's bills come apart, learned from its own
 * statements rather than assumed from its cadence: a "monthly" SDG&E bill
 * runs 28 to 33 days, and fetching on day 27 of a 30-day guess found
 * nothing, backed off, and the bill waited for a manual sync. The recent
 * gaps between statement dates (newest first) are taken; one far off the
 * usual (a missing bill doubles a gap, a corrected bill halves one) is set
 * aside, and of the rest the longest is used — on that day the bill is out
 * whichever way this cycle ran. Too little history: the cadence's cycle.
 */
export function learnedCycleDays(statementDates: Date[], cadence: string | null | undefined, termMonths?: number | null): { days: number; learned: boolean } {
  const fallback = billCycleDays(cadence, termMonths);
  const days = [...statementDates].map(d => d.getTime()).sort((a, b) => b - a).slice(0, 7);
  const gaps: number[] = [];
  for (let i = 0; i + 1 < days.length; i++) {
    const g = Math.round((days[i] - days[i + 1]) / 86400000);
    if (g > 3) gaps.push(g);   // two bills days apart are a re-bill, not a cycle
  }
  if (gaps.length < 2) return { days: fallback, learned: false };
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const usual = gaps.filter(g => g >= median * 0.6 && g <= median * 1.4);
  return { days: Math.max(...(usual.length ? usual : [median])), learned: true };
}
