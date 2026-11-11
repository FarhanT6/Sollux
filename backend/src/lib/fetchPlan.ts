/**
 * When Sollux fetches an account's statements on its own, and what this
 * month's fetching came to — pure, so the worker (scrapeWorker scheduledSkip),
 * the scheduler (services/fetchScheduler.ts) and Settings → AI usage's month
 * view (services/fetchMonth.ts) read one rule.
 *
 * A fetch nobody asked for (the schedule, or a "your bill is ready" email):
 * - not before the next bill is due by the account's own cycle; a bill-ready
 *   email is believed from 10 days before that, not right after a bill was
 *   filed (some providers send "view your statement online" every few days);
 * - never twice in 20 hours;
 * - and once due, runs that found nothing back off: 1, 2, 4, then every 7
 *   days, until a new statement comes in.
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** How often the schedule looks at every account (workers/index.ts). */
export const SCHEDULE_EVERY_HOURS = 6;
/** Days after the expected statement date before a missing one is late, not just due. */
export const LATE_AFTER_DAYS = 5;

export interface FetchWaitInput {
  now: Date;
  /** When the next statement should be out (newest statement + the account's cycle); null with none on file. */
  nextOn: Date | null;
  lastStatementDate: Date | null;
  /** The account's last portal run, whatever it found. */
  lastRun: Date | null;
  /** Runs since the newest statement came in that brought nothing. */
  misses: number;
  billPosted?: boolean;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Why a fetch nobody asked for should not run now (skip), or null when it should; and when it next may. */
export function fetchWait(i: FetchWaitInput): { skip: string | null; nextAt: Date } {
  const now = i.now.getTime();
  const lead = i.billPosted ? 10 * DAY : 0;
  if (i.nextOn && now < i.nextOn.getTime() - lead) {
    return { skip: `the ${i.lastStatementDate ? ymd(i.lastStatementDate) : 'last'} statement is the latest; the next is expected about ${ymd(i.nextOn)}`, nextAt: new Date(i.nextOn.getTime() - lead) };
  }
  const sinceRun = i.lastRun ? now - i.lastRun.getTime() : Infinity;
  if (sinceRun < 20 * HOUR) return { skip: 'already ran today', nextAt: new Date(i.lastRun!.getTime() + 20 * HOUR) };
  if (i.billPosted && i.misses < 2) return { skip: null, nextAt: i.now };
  const wait = i.misses === 0 ? 0 : Math.min(2 ** (i.misses - 1), 7) * DAY;
  if (sinceRun < wait) {
    return {
      skip: `${i.misses} run${i.misses === 1 ? '' : 's'} since the last statement found nothing; next try in ${Math.ceil((wait - sinceRun) / DAY)} day(s)`,
      nextAt: new Date(i.lastRun!.getTime() + wait),
    };
  }
  return { skip: null, nextAt: i.now };
}

/** The first schedule run at or after `at` (runs every SCHEDULE_EVERY_HOURS from `lastScheduleRun`). */
export function nextScheduleRun(at: Date, lastScheduleRun: Date | null, now: Date): Date {
  const step = SCHEDULE_EVERY_HOURS * HOUR;
  const base = lastScheduleRun ? lastScheduleRun.getTime() : now.getTime();
  const from = Math.max(at.getTime(), now.getTime());
  const k = Math.max(0, Math.ceil((from - base) / step));
  return new Date(base + k * step);
}

export type MonthState =
  /** A statement dated this month is on file. */
  | 'got'
  /** Expected this month and not out yet. */
  | 'coming'
  /** The expected date has passed, within LATE_AFTER_DAYS: being fetched now. */
  | 'due'
  /** Expected more than LATE_AFTER_DAYS ago (this month or before) and not on file. */
  | 'late'
  /** This account bills every two months or longer, and not this month. */
  | 'not-this-month'
  /** No statement on file yet to learn its cycle from. */
  | 'no-history';

/**
 * Where an account stands for one month: its statement for the month on file,
 * or when it should come out (the newest statement before the month plus its
 * cycle) and whether that has passed.
 */
export function monthState(
  statements: { statementDate: Date }[], cycleDays: number,
  month: { start: Date; end: Date }, now: Date,
): { state: MonthState; expectedOn: Date | null; gotIndex: number } {
  const t = (d: Date) => d.getTime();
  const gotIndex = statements.findIndex(s => t(s.statementDate) >= t(month.start) && t(s.statementDate) < t(month.end));
  if (gotIndex >= 0) return { state: 'got', expectedOn: null, gotIndex };
  const prior = statements.filter(s => t(s.statementDate) < t(month.start)).sort((a, b) => t(b.statementDate) - t(a.statementDate))[0];
  if (!prior) return { state: 'no-history', expectedOn: null, gotIndex: -1 };
  const expectedOn = new Date(t(prior.statementDate) + cycleDays * DAY);
  if (t(expectedOn) >= t(month.end)) return { state: 'not-this-month', expectedOn, gotIndex: -1 };
  if (t(now) < t(expectedOn)) return { state: 'coming', expectedOn, gotIndex: -1 };
  if (t(now) < t(expectedOn) + LATE_AFTER_DAYS * DAY) return { state: 'due', expectedOn, gotIndex: -1 };
  return { state: 'late', expectedOn, gotIndex: -1 };
}

/** How a statement came in, from what intake recorded on it. */
export function statementVia(s: { rawDataJson: unknown; sourceType: string }): 'portal' | 'email' | 'upload' | 'typed' {
  const src = (s.rawDataJson as { source?: string } | null)?.source;
  if (src === 'email') return 'email';
  if (src === 'portal' || s.sourceType === 'SCRAPER') return 'portal';
  if (src === 'drive_import' || src === 'pdf_import' || s.rawDataJson) return 'upload';
  return 'typed';
}

/** The first day of a "YYYY-MM" month and of the next, in UTC (statement dates are stored at midnight UTC). */
export function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}
