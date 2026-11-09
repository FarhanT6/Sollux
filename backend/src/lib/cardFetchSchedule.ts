/**
 * When a card's statement is fetched from its website without anyone asking
 * (the schedule, or a "your statement is ready" email). Each run is a browser,
 * Claude calls and often a code, so:
 * - not before the next statement can be out: a few days after the closing
 *   date that follows the newest statement on file (a statement-ready email is
 *   believed from a few days before it);
 * - never twice in a day;
 * - and once due, runs that found nothing back off: 1, 2, 4, then every 7 days,
 *   until a statement comes in by any route.
 * Pure: the worker (scrapeWorker cardJob) passes what it read.
 */
const DAY = 86_400_000;

/** The closing date after `last`: the card's closing day in the next month, else a month on (clamped to the month's length). */
export function nextClosing(last: Date, closingDay: number | null): Date {
  const y = last.getUTCFullYear(), m = last.getUTCMonth() + 1;
  const want = closingDay && closingDay >= 1 && closingDay <= 31 ? closingDay : last.getUTCDate();
  const len = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(want, len)));
}

export interface CardFetchState {
  now: Date;
  autoFetch: boolean;
  closed: boolean;
  /** The newest statement on file with its PDF (not an email's stand-in). */
  newestClosing: Date | null;
  /** When that statement (or any newer one) was saved: a statement since the last run resets the back-off. */
  newestSavedAt: Date | null;
  closingDay: number | null;
  lastRunAt: Date | null;
  misses: number;
  /** A statement-ready email asked for it. */
  billPosted?: boolean;
}

/** Why a fetch nobody asked for should not run now, or null when it should. */
export function cardFetchSkip(s: CardFetchState): string | null {
  if (!s.autoFetch) return 'automatic fetching is off for this card';
  if (s.closed) return 'the card is closed';
  const now = s.now.getTime();
  if (s.newestClosing) {
    const next = nextClosing(s.newestClosing, s.closingDay);
    // Statements post a few days after closing; a ready email is taken at its word from a few days before.
    const from = next.getTime() + (s.billPosted ? -3 : 3) * DAY;
    if (now < from) return `the ${s.newestClosing.toISOString().slice(0, 10)} statement is the latest; the next closes about ${next.toISOString().slice(0, 10)}`;
  }
  const sinceRun = s.lastRunAt ? now - s.lastRunAt.getTime() : Infinity;
  if (sinceRun < 20 * 3_600_000) return 'already ran today';
  const misses = s.newestSavedAt && s.lastRunAt && s.newestSavedAt > s.lastRunAt ? 0 : s.misses;
  if (s.billPosted && misses < 2) return null;
  const wait = misses === 0 ? 0 : Math.min(2 ** (misses - 1), 7) * DAY;
  if (sinceRun < wait) return `${misses} run${misses === 1 ? '' : 's'} since the last statement found nothing; next try in ${Math.ceil((wait - sinceRun) / DAY)} day(s)`;
  return null;
}
