/**
 * Settings → AI usage → This month's statements: for one month, every active
 * account's statement — on file (and how it came in), or when it should be
 * out and why it is not here yet: not out yet, being fetched, tried and not
 * on the website yet, the last try failed, waiting for a code, nothing saved
 * to fetch with, or fetching turned off — and when Sollux tries next.
 */
import { db } from '../config/db';
import { learnedCycleDays } from '../lib/billCadence';
import {
  fetchWait, monthBounds, monthState, nextScheduleRun, statementVia, type MonthState,
} from '../lib/fetchPlan';
import { canFetch, lastScheduleRun, loginKey } from './fetchScheduler';
import { scrapeQueue } from '../workers/queues';

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const short = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export interface MonthAccount {
  id: string; providerName: string; last4: string | null; place: string; propertyId: string; category: string; personal: boolean;
  state: MonthState;
  /** When this month's statement should be (or should have been) out. */
  expectedOn: string | null;
  got: { statementId: string; statementDate: string; amountDue: number | null; via: 'portal' | 'email' | 'upload' | 'typed'; addedAt: string } | null;
  /** How Sollux gets it by itself: a portal login or lookup page; null when it cannot. */
  fetchable: boolean; syncEnabled: boolean; running: boolean; waitingForCode: boolean;
  lastTry: { at: string; ok: boolean; found: number; error: string | null } | null;
  /** Runs since it was due that found nothing. */
  triesSinceDue: number;
  /** When the schedule tries it next (fetchable, due or coming). */
  nextTry: string | null;
  /** Why it is where it is, in a sentence. */
  why: string;
}

export interface FetchMonth {
  month: string; months: string[];
  schedule: { lastRunAt: string | null; everyHours: number };
  counts: Record<MonthState, number>;
  accounts: MonthAccount[];
}

const monthKeyOf = (d: Date) => d.toISOString().slice(0, 7);
function lastMonths(now: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(monthKeyOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  return out;
}

export async function fetchMonth(userId: string, month: string | null, now = new Date()): Promise<FetchMonth> {
  const thisMonth = monthKeyOf(now);
  const m = month && /^\d{4}-\d{2}$/.test(month) && month <= thisMonth ? month : thisMonth;
  const bounds = monthBounds(m);
  const accounts = await db.utilityAccount.findMany({
    where: { property: { userId }, isActive: true, escrowLoanId: null, billingCadence: { not: 'ONE_TIME' } },
    select: {
      id: true, providerName: true, providerSlug: true, loginUrl: true, usernameEnc: true, passwordEnc: true, lookupCustomerId: true,
      accountNumber: true, category: true, billingCadence: true, termMonths: true, syncEnabled: true, lastAgentRunAt: true,
      mfaPrompt: true, mfaRequestedAt: true, isPersonal: true, propertyId: true,
      property: { select: { nickname: true, address: true, userId: true } },
      statements: {
        where: { isScheduled: false, isDownPayment: false }, orderBy: { statementDate: 'desc' }, take: 14,
        select: { id: true, statementDate: true, createdAt: true, amountDue: true, rawDataJson: true, sourceType: true },
      },
    },
    orderBy: [{ providerName: 'asc' }],
  });
  const ids = accounts.map(a => a.id);
  const jobs = ids.length ? await db.syncJob.findMany({
    where: { utilityAccountId: { in: ids }, createdAt: { gte: new Date(now.getTime() - 120 * DAY) } },
    orderBy: { createdAt: 'desc' },
    select: { utilityAccountId: true, status: true, createdAt: true, startedAt: true, completedAt: true, statementsFound: true, error: true },
  }) : [];
  const jobsOf = new Map<string, typeof jobs>();
  for (const j of jobs) jobsOf.set(j.utilityAccountId, [...(jobsOf.get(j.utilityAccountId) ?? []), j]);
  const lastRun = await lastScheduleRun();

  const out: MonthAccount[] = accounts.map(a => {
    const stmts = a.statements;
    const { days: cycle } = learnedCycleDays(stmts.map(s => s.statementDate), a.billingCadence, a.termMonths);
    const ms = monthState(stmts, cycle, bounds, now);
    const fetchable = canFetch(a);
    const mine = jobsOf.get(a.id) ?? [];
    const running = mine.some(j => j.status === 'PENDING' && !j.completedAt && now.getTime() - j.createdAt.getTime() < 15 * 60_000);
    const done = mine.filter(j => j.completedAt);
    const last = done[0] ?? null;
    const lastTry = last ? { at: last.completedAt!.toISOString(), ok: last.status === 'SUCCESS', found: last.statementsFound, error: last.status === 'SUCCESS' ? null : last.error } : null;
    const expectedOn = ms.expectedOn;
    const triesSinceDue = expectedOn ? done.filter(j => j.completedAt! >= expectedOn && j.statementsFound === 0).length : 0;
    const waitingForCode = !!a.mfaPrompt && !!a.mfaRequestedAt && now.getTime() - a.mfaRequestedAt.getTime() < 30 * 60_000;

    // When the schedule tries next: the account's own plan (its newest statement, not the month's).
    let nextTry: Date | null = null;
    if (fetchable && a.syncEnabled && ms.state !== 'got') {
      const newest = stmts[0] ?? null;
      const misses = done.filter(j => j.completedAt! > (newest?.createdAt ?? new Date(now.getTime() - 60 * DAY)) && j.statementsFound === 0).length;
      const w = fetchWait({ now, nextOn: newest ? new Date(newest.statementDate.getTime() + cycle * DAY) : null, lastStatementDate: newest?.statementDate ?? null, lastRun: a.lastAgentRunAt, misses });
      nextTry = nextScheduleRun(w.nextAt, lastRun, now);
    }

    const got = ms.state === 'got' ? stmts[ms.gotIndex] : null;
    const exp = expectedOn ? short(expectedOn) : '';
    const why = (() => {
      if (got) return '';
      if (ms.state === 'not-this-month') return `Not billed this month: bills come about every ${Math.round(cycle / 30.44)} months; the next is expected about ${exp}.`;
      if (!a.syncEnabled) return 'Fetching is turned off for this account.';
      if (!fetchable) return 'No portal login or bill lookup page saved, so Sollux cannot fetch it; it comes in only by email or upload.';
      if (running) return 'Fetching now.';
      if (waitingForCode) return 'Waiting for the code the provider sent — enter it where Fetch was pressed.';
      if (ms.state === 'no-history') return 'No statement on file yet, so Sollux does not know when it comes out. Fetch now gets the first one.';
      if (ms.state === 'coming') return `Not out yet: expected about ${exp}. Sollux looks for it from then.`;
      const tried = last && expectedOn && last.completedAt! >= expectedOn;
      if (tried && last!.status !== 'SUCCESS') return `Expected about ${exp}. The last try (${short(last!.completedAt!)}) failed: ${(last!.error ?? 'no reason saved').slice(0, 200)}`;
      if (tried) return `Expected about ${exp}. Tried ${triesSinceDue} time${triesSinceDue === 1 ? '' : 's'} since; it was not on the website yet.`;
      return `Expected about ${exp}, and not tried since.`;
    })();

    return {
      id: a.id, providerName: a.providerName, last4: a.accountNumber ? String(a.accountNumber).slice(-4) : null,
      place: a.property.nickname || a.property.address, propertyId: a.propertyId, category: a.category, personal: a.isPersonal,
      state: ms.state, expectedOn: expectedOn ? ymd(expectedOn) : null,
      got: got ? { statementId: got.id, statementDate: ymd(got.statementDate), amountDue: got.amountDue == null ? null : Number(got.amountDue), via: statementVia(got), addedAt: got.createdAt.toISOString() } : null,
      fetchable, syncEnabled: a.syncEnabled, running, waitingForCode, lastTry, triesSinceDue,
      nextTry: nextTry ? nextTry.toISOString() : null, why,
    };
  });

  // An account whose records start after this month was not tracked then: left out, not "no statement yet".
  const shown = out.filter((a, i) => !(a.state === 'no-history' && accounts[i].statements.length > 0));
  const counts = { got: 0, coming: 0, due: 0, late: 0, 'not-this-month': 0, 'no-history': 0 } as Record<MonthState, number>;
  for (const a of shown) counts[a.state]++;
  return {
    month: m, months: lastMonths(now, 6),
    schedule: { lastRunAt: lastRun ? lastRun.toISOString() : null, everyHours: 6 },
    counts, accounts: shown,
  };
}

/**
 * Fetch now for several accounts: the given ones, else every one due or late
 * this month that Sollux can fetch. One run per login (its other accounts ride
 * along); accounts already being fetched are left alone.
 */
export async function fetchMissing(userId: string, only: string[] | null, now = new Date()): Promise<{ queued: number; accounts: number }> {
  const month = await fetchMonth(userId, null, now);
  const want = month.accounts.filter(a => a.fetchable && a.syncEnabled && !a.running && !a.waitingForCode
    && (only ? only.includes(a.id) : a.state === 'due' || a.state === 'late' || a.state === 'no-history'));
  if (!want.length) return { queued: 0, accounts: 0 };
  const rows = await db.utilityAccount.findMany({
    where: { id: { in: want.map(a => a.id) }, property: { userId } },
    select: { id: true, providerName: true, providerSlug: true, loginUrl: true, usernameEnc: true, passwordEnc: true, lookupCustomerId: true },
  });
  const seen = new Set<string>();
  let queued = 0;
  for (const r of rows) {
    const k = loginKey({ ...r, userId });
    if (seen.has(k)) continue;
    seen.add(k);
    const job = await db.syncJob.create({ data: { utilityAccountId: r.id, status: 'PENDING', progress: 'Queued — waiting for the background worker' } });
    await scrapeQueue.add('scrape', { utilityAccountId: r.id, manual: true, syncJobId: job.id }, { jobId: `missing-${r.id}-${now.getTime()}`, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } });
    queued++;
  }
  return { queued, accounts: want.length };
}
