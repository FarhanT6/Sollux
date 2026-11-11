/**
 * The schedule that fetches every account's statements on its own.
 *
 * It ran from a setInterval of 6 hours with no first run, so every restart of
 * the worker (each deploy, several a day) started the 6 hours over and on
 * busy days it never ran at all. Now a tick every 15 minutes runs it when the
 * last run (kept in app_settings, so it survives restarts) is 6 hours old.
 *
 * Accounts on one login are fetched in one run (the agent takes the login's
 * other accounts along), so one job goes per login. Which account leads it
 * used to be the first one found; when that one's next bill was not due the
 * run was skipped, and the login's other accounts — billed on other days —
 * waited for it. Now the job goes for the account on the login that is due.
 */
import { db } from '../config/db';
import { decrypt } from '../crypto/encrypt';
import { scrapeQueue } from '../workers/queues';
import { isLookupAccount, isLookupPage, websiteFor } from '../lib/providerDirectory';
import { SCHEDULE_EVERY_HOURS } from '../lib/fetchPlan';
import { scheduledWait } from './nextFetch';

const LAST_RUN_KEY = 'fetch-schedule:last-run';
const HOUR = 3_600_000;

type Fetchable = { providerSlug: string | null; providerName: string; loginUrl: string | null; usernameEnc: string | null; passwordEnc?: string | null; lookupCustomerId: string | null };

/** Whether Sollux has what it needs to fetch an account by itself: a portal login, or a bill lookup page. */
export function canFetch(a: Fetchable): boolean {
  return !!a.usernameEnc || isLookupAccount(a);
}

/** The login an account is fetched under: accounts sharing one are fetched in one run. A lookup page goes one account at a time. */
export function loginKey(a: Fetchable & { id: string; userId: string }): string {
  if (!a.usernameEnc || isLookupPage(a.loginUrl)) return `one:${a.id}`;
  // Same username and password, as the worker's sameLogin takes them along (a stale password under the same username is not the same login).
  let user = '';
  try { user = `${decrypt(a.usernameEnc).trim().toLowerCase()}\u0000${a.passwordEnc ? decrypt(a.passwordEnc) : ''}`; } catch { return `one:${a.id}`; }
  let host = a.providerSlug ?? '';
  try { host = new URL(websiteFor(a)!.url).hostname.split('.').slice(-2).join('.'); } catch { /* the slug */ }
  return `${a.userId}:${host}:${user}`;
}

export async function lastScheduleRun(): Promise<Date | null> {
  const row = await db.appSetting.findUnique({ where: { key: LAST_RUN_KEY } }).catch(() => null);
  const d = row ? new Date(row.value) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

/** Queue a fetch for every login with an account due. Returns how many were queued and why the rest were not. */
export async function scheduleAllScrapes(now = new Date()): Promise<{ queued: number; accounts: number; notDue: number }> {
  const rows = await db.utilityAccount.findMany({
    where: { syncEnabled: true, isActive: true, escrowLoanId: null, billingCadence: { not: 'ONE_TIME' } },
    select: {
      id: true, providerName: true, providerSlug: true, loginUrl: true, usernameEnc: true, passwordEnc: true, lookupCustomerId: true,
      billingCadence: true, termMonths: true, lastAgentRunAt: true, property: { select: { userId: true } },
    },
  });
  const accounts = rows.filter(canFetch).map(a => ({ ...a, userId: a.property.userId }));
  const groups = new Map<string, typeof accounts>();
  for (const a of accounts) {
    const k = loginKey(a);
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const slot = Math.floor(now.getTime() / (SCHEDULE_EVERY_HOURS * HOUR));
  let queued = 0, notDue = 0;
  for (const members of groups.values()) {
    let lead: (typeof accounts)[number] | null = null;
    for (const m of members) {
      const w = await scheduledWait(m, false, now).catch(() => null);
      if (w && !w.skip) { lead = m; break; }
    }
    if (!lead) { notDue += members.length; continue; }
    // One job per login per schedule slot: a second worker running during a deploy does not queue it again.
    await scrapeQueue.add('scrape', { utilityAccountId: lead.id }, {
      jobId: `sched-${lead.id}-${slot}`, attempts: 1, removeOnComplete: { count: 200 }, removeOnFail: { count: 100 },
    });
    queued++;
  }
  console.log(`[Scheduler] ${queued} fetch(es) queued for ${accounts.length} fetchable account(s); ${notDue} not due yet`);
  return { queued, accounts: accounts.length, notDue };
}

/** Run the schedule when its last run is SCHEDULE_EVERY_HOURS old (or never ran); called every 15 minutes. */
export async function scheduleTick(now = new Date()): Promise<boolean> {
  const last = await lastScheduleRun();
  if (last && now.getTime() - last.getTime() < SCHEDULE_EVERY_HOURS * HOUR - 60_000) return false;
  await db.appSetting.upsert({ where: { key: LAST_RUN_KEY }, create: { key: LAST_RUN_KEY, value: now.toISOString() }, update: { value: now.toISOString() } });
  await scheduleAllScrapes(now);
  return true;
}
