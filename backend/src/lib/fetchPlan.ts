/**
 * When Sollux fetches an account's statements on its own, and what this
 * month's fetching came to — pure, so the worker (scrapeWorker scheduledSkip),
 * the scheduler (services/fetchScheduler.ts) and Settings → AI usage's month
 * view (services/fetchMonth.ts) read one rule.
 *
 * A fetch nobody asked for (the schedule, or a "your bill is ready" email):
 * - when the next statement should be out: a monthly bill on the day of the month its statements
 *   usually come out (SoCal Gas mailed on the 13th: the 13th), else the last one plus its cycle —
 *   and fetched at midnight after that day (FETCH_TZ), when the day's statement is surely posted.
 *   It looked for the newest statement plus the LONGEST recent gap, so a bill mailed the 13th was
 *   first looked for on the 17th;
 * - not before then; a bill-ready
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
  /** When the next statement should be out (nextStatementAfter); null with none on file. */
  nextOn: Date | null;
  /** When to look for it: midnight after nextOn (midnightAfter). Without it, nextOn itself. */
  fetchAt?: Date | null;
  lastStatementDate: Date | null;
  /** The account's last portal run, whatever it found. */
  lastRun: Date | null;
  /** Runs since it was due (and since the newest statement came in) that brought nothing. */
  misses: number;
  billPosted?: boolean;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

/** The time zone a statement's day ends in: the schedule fetches at midnight after it. */
export const FETCH_TZ = process.env.FETCH_TZ || 'America/Los_Angeles';

/**
 * The day of the month an account's statements usually come out on, when they come monthly on about
 * the same day (the 12th, 13th, 15th, 13th…); null otherwise — every two months, a term, too few on
 * file, or dates either side of a month's turn (the 30th, then the 2nd), where the day is no pattern.
 */
export function usualStatementDay(dates: Date[]): number | null {
  const ds = [...dates].sort((a, b) => b.getTime() - a.getTime()).slice(0, 7);
  const gaps: number[] = [];
  for (let i = 0; i + 1 < ds.length; i++) {
    const g = Math.round((ds[i].getTime() - ds[i + 1].getTime()) / DAY);
    if (g > 3) gaps.push(g);   // a re-bill days later is not a cycle
  }
  if (gaps.length < 2) return null;
  const g = median(gaps);
  if (g < 26 || g > 35) return null;
  const days = ds.filter((d, i) => i === 0 || Math.round((ds[i - 1].getTime() - d.getTime()) / DAY) > 3).slice(0, 6).map(d => d.getUTCDate());
  if (Math.max(...days) - Math.min(...days) > 8) return null;
  return median(days);
}

/** When the statement after `prior` should come out: the usual day of the next month for a monthly bill, else `prior` plus the cycle. */
export function nextStatementAfter(prior: Date, history: Date[], cycleDays: number): Date {
  const day = usualStatementDay(history.filter(d => d.getTime() <= prior.getTime()));
  if (day == null) return new Date(prior.getTime() + cycleDays * DAY);
  const on = (y: number, m: number) => new Date(Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())));
  let t = on(prior.getUTCFullYear(), prior.getUTCMonth() + 1);
  // A statement late in its month (the 20th when the 13th is usual): the next is a month after the one it stood for.
  if (t.getTime() - prior.getTime() < 20 * DAY) t = on(prior.getUTCFullYear(), prior.getUTCMonth() + 2);
  return t;
}

/** Midnight, in `tz`, at the end of the calendar day `day` (a date stored at midnight UTC). */
export function midnightAfter(day: Date, tz = FETCH_TZ): Date {
  const y = day.getUTCFullYear(), m = day.getUTCMonth(), d = day.getUTCDate() + 1;
  const noon = new Date(Date.UTC(y, m, d, 12));
  let offsetMin = 0;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(noon).find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
    const mm = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (mm) offsetMin = (mm[1] === '-' ? -1 : 1) * (Number(mm[2]) * 60 + Number(mm[3] ?? 0));
  } catch { /* an unknown zone: UTC */ }
  return new Date(Date.UTC(y, m, d) - offsetMin * 60_000);
}

/** Why a fetch nobody asked for should not run now (skip), or null when it should; and when it next may. */
export function fetchWait(i: FetchWaitInput): { skip: string | null; nextAt: Date } {
  const now = i.now.getTime();
  const lead = i.billPosted ? 10 * DAY : 0;
  const due = i.fetchAt ?? i.nextOn;
  if (due && i.nextOn && now < due.getTime() - lead) {
    return { skip: `the ${i.lastStatementDate ? ymd(i.lastStatementDate) : 'last'} statement is the latest; the next is expected about ${ymd(i.nextOn)}`, nextAt: new Date(due.getTime() - lead) };
  }
  // Only runs since it was due count: a run before (another account on the same login, a Fetch
  // pressed early) could not have found it, and must not hold back the one at midnight after it.
  const ranSinceDue = !!i.lastRun && (!due || i.lastRun.getTime() >= due.getTime() - lead);
  const sinceRun = ranSinceDue ? now - i.lastRun!.getTime() : Infinity;
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
  /** When the statement after one should come out (nextStatementAfter); without it, that one plus the cycle. */
  expectedAfter?: (prior: Date) => Date,
): { state: MonthState; expectedOn: Date | null; gotIndex: number } {
  const t = (d: Date) => d.getTime();
  const gotIndex = statements.findIndex(s => t(s.statementDate) >= t(month.start) && t(s.statementDate) < t(month.end));
  if (gotIndex >= 0) return { state: 'got', expectedOn: null, gotIndex };
  const prior = statements.filter(s => t(s.statementDate) < t(month.start)).sort((a, b) => t(b.statementDate) - t(a.statementDate))[0];
  if (!prior) return { state: 'no-history', expectedOn: null, gotIndex: -1 };
  const expectedOn = expectedAfter ? expectedAfter(prior.statementDate) : new Date(t(prior.statementDate) + cycleDays * DAY);
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
