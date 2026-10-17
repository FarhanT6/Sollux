import { Worker, Job } from 'bullmq';
import { jobStarted, jobEnded } from './heartbeat';
import { withAiContext } from '../ai/meter';
import { overdueAfterDays, billCycleDays } from '../lib/billCadence';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { decrypt } from '../crypto/encrypt';
import { getScraperProvider } from '../scrapers/registry';
import { runPortalAgent } from '../scrapers/portalAgent';
import { uploadDocument, buildStatementKey } from '../services/s3Service';
import { guardWorker } from './redisGuard';
import { insightQueue, scrapeQueue, createWorkerConnection, workerTuning } from './queues';
import { websiteFor } from '../lib/providerDirectory';

interface ScrapeJobData {
  utilityAccountId: string;
  /** Pressed Sync: the portal agent runs even if it ran recently. */
  manual?: boolean;
  /** Why it was queued: a provider's "your bill is ready" email fetches the statement at once. */
  trigger?: 'bill_posted';
  /** Started from the AI test run: its spend is filed as a test (ai/meter.ts). */
  test?: boolean;
  /** The sync job the API created when Fetch was pressed, so its status shows at once. */
  syncJobId?: string;
  /** Use the portal agent even though a built-in scraper exists (that scraper just failed). */
  forceAgent?: boolean;
}

// Normalise account number for matching (strip dashes/spaces/case)
function normalizeAcct(s: string) {
  return s.replace(/[-\s]/g, '').toLowerCase();
}

/**
 * An error a person can read: the first line, without the browser's launch
 * log Playwright appends ("Browser logs: <launching> …" ran to thousands of
 * characters on the page).
 */
function readableError(message: string): string {
  return message.split(/\s*(?:Browser logs:|=+ logs =+|Call log:)/)[0].split('\n')[0].trim().slice(0, 300) || 'The fetch failed.';
}

/** Every downloaded statement accounted for: filed, waiting for review, applied to a notice or policy, or unreadable. */
function downloadSummary(r: { downloads: number; filed: number; review: number; applied: number }): string {
  const unread = Math.max(0, r.downloads - r.filed - r.review - r.applied);
  const parts = [r.filed && `${r.filed} filed`, r.review && `${r.review} to review in Import`, r.applied && `${r.applied} applied`, unread && `${unread} could not be read`].filter(Boolean);
  return `Downloaded ${r.downloads} statement${r.downloads === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

/**
 * A rejected login explained: another account on the same site saved with
 * the same username but a different password. A site has one password per
 * username, so one of the two is out of date — and each failed try with it
 * counts against the other's login too (IID ··9413 failing took ··2917 down
 * with it).
 */
export async function loginClash(accountId: string): Promise<string> {
  const site = { providerName: true, providerSlug: true, loginUrl: true } as const;
  const me = await db.utilityAccount.findUnique({ where: { id: accountId }, select: { ...site, usernameEnc: true, passwordEnc: true, property: { select: { userId: true } } } });
  if (!me?.usernameEnc || !me.passwordEnc) return '';
  // The same site, by its web address — not the provider slug, which every
  // agent-only account shares (SDCCU was compared with AmTrust and CR&R).
  const rootOf = (a: { providerName: string; providerSlug: string | null; loginUrl: string | null }) => {
    try { return new URL(websiteFor(a)!.url).hostname.split('.').slice(-2).join('.'); } catch { return null; }
  };
  const mine = rootOf(me);
  if (!mine) return '';
  const others = (await db.utilityAccount.findMany({ where: { id: { not: accountId }, property: { userId: me.property.userId }, usernameEnc: { not: null } }, select: { ...site, accountNumber: true, usernameEnc: true, passwordEnc: true, property: { select: { nickname: true, address: true } } } }))
    .filter(o => rootOf(o) === mine);
  try {
    const user = decrypt(me.usernameEnc).trim().toLowerCase(), pass = decrypt(me.passwordEnc);
    const clash = others.filter(o => o.passwordEnc && decrypt(o.usernameEnc!).trim().toLowerCase() === user && decrypt(o.passwordEnc) !== pass);
    if (!clash.length) return '';
    const names = clash.map(o => `${o.accountNumber ? `··${String(o.accountNumber).slice(-4)}` : ''} (${o.property.nickname || o.property.address})`.trim()).join(', ');
    return ` Note: ${names} is saved with the same username but a different password. A site has one password per username, so one of them is out of date — if these are separate logins, the username on one of them is wrong. Fix it on the account before fetching again: every rejected try counts against that login.`;
  } catch { return ''; }
}
/**
 * The owner's other accounts on the same login: the same site (by its web
 * address), the same username and the same password, syncing on. One
 * sign-in fetches them all.
 */
async function sameLogin(accountId: string): Promise<{ id: string; label: string }[]> {
  const site = { providerName: true, providerSlug: true, loginUrl: true } as const;
  const me = await db.utilityAccount.findUnique({ where: { id: accountId }, select: { ...site, usernameEnc: true, passwordEnc: true, property: { select: { userId: true } } } });
  if (!me?.usernameEnc || !me.passwordEnc) return [];
  const rootOf = (a: { providerName: string; providerSlug: string | null; loginUrl: string | null }) => {
    try { return new URL(websiteFor(a)!.url).hostname.split('.').slice(-2).join('.'); } catch { return null; }
  };
  const mine = rootOf(me);
  if (!mine) return [];
  try {
    const user = decrypt(me.usernameEnc).trim().toLowerCase(), pass = decrypt(me.passwordEnc);
    const all = await db.utilityAccount.findMany({ where: { id: { not: accountId }, syncEnabled: true, property: { userId: me.property.userId }, usernameEnc: { not: null }, passwordEnc: { not: null } }, select: { ...site, id: true, accountNumber: true, usernameEnc: true, passwordEnc: true } });
    return all.filter(o => rootOf(o) === mine && decrypt(o.usernameEnc!).trim().toLowerCase() === user && decrypt(o.passwordEnc!) === pass)
      .slice(0, 9)
      .map(o => ({ id: o.id, label: o.accountNumber ? `··${String(o.accountNumber).slice(-4)}` : o.providerName }));
  } catch { return []; }
}

const REJECTED = /rejected the username or password|login failed|invalid (email|user|username|credentials)|incorrect (password|username)/i;

/**
 * One portal-agent run for an account: the sync job (the one Fetch created,
 * or a new one) shows live progress, and ends with what came back and what it
 * cost. Never retried automatically: a retry could re-trigger a code or lock
 * the login.
 */
export async function agentJob(job: Job<ScrapeJobData>, account: { id: string; providerName: string; property: { id: string } }): Promise<void> {
  const utilityAccountId = account.id;
    await db.utilityAccount.update({ where: { id: utilityAccountId }, data: { lastSyncStatus: 'PENDING' } });
    const syncJob = job.data.syncJobId
      ? await db.syncJob.update({ where: { id: job.data.syncJobId }, data: { status: 'PENDING', startedAt: new Date(), progress: 'Starting the browser' } }).catch(() => null)
        ?? await db.syncJob.create({ data: { utilityAccountId, status: 'PENDING', startedAt: new Date() } })
      : await db.syncJob.create({ data: { utilityAccountId, status: 'PENDING', startedAt: new Date(), progress: 'Starting the browser' } });
    // The live line where Fetch was pressed: at most one write every 2 seconds,
    // but the latest line always lands (a dropped "Looking for the code in your
    // email" left "clicking Log in" on screen for the two minutes it took).
    // The same login's other accounts ride along: their rows show this run, and
    // a Fetch already queued for one of them is answered by it.
    const also = await sameLogin(utilityAccountId);
    const me = await db.utilityAccount.findUnique({ where: { id: utilityAccountId }, select: { accountNumber: true } });
    const myLabel = me?.accountNumber ? `··${String(me.accountNumber).slice(-4)}` : account.providerName;
    const alsoJobs: string[] = [];
    for (const o of also) {
      const pending = await db.syncJob.findMany({ where: { utilityAccountId: o.id, status: 'PENDING' }, select: { id: true } });
      if (pending.length) alsoJobs.push(...pending.map(j => j.id));
      else alsoJobs.push((await db.syncJob.create({ data: { utilityAccountId: o.id, status: 'PENDING', startedAt: new Date(), progress: `In the same sign-in as ${myLabel}` } })).id);
    }
    if (also.length) await db.utilityAccount.updateMany({ where: { id: { in: also.map(o => o.id) } }, data: { lastSyncStatus: 'PENDING' } });
    let lastWrite = 0, latest = '', timer: NodeJS.Timeout | null = null;
    const write = () => {
      timer = null; lastWrite = Date.now();
      void db.syncJob.update({ where: { id: syncJob.id }, data: { progress: latest.slice(0, 300) } }).catch(() => {});
      if (alsoJobs.length) void db.syncJob.updateMany({ where: { id: { in: alsoJobs }, status: 'PENDING' }, data: { progress: `With ${myLabel} (same login) · ${latest}`.slice(0, 300) } }).catch(() => {});
    };
    const onProgress = (text: string) => {
      latest = text;
      if (timer) return;
      const wait = 2000 - (Date.now() - lastWrite);
      if (wait <= 0) write(); else timer = setTimeout(write, wait);
    };
    const r = await withAiContext({ test: !!job.data.test }, () => runPortalAgent(utilityAccountId, { interactive: !!job.data.manual, onProgress, also: also.map(o => o.id), cancelled: async () => (await db.syncJob.findUnique({ where: { id: syncJob.id }, select: { status: true } }))?.status === 'FAILED'
      // Cancel pressed on any account in the sign-in stops it.
      || (alsoJobs.length > 0 && !!(await db.syncJob.findFirst({ where: { id: { in: alsoJobs }, status: 'FAILED', error: 'Cancelled by you.' }, select: { id: true } }))) }))
      .catch(err => ({ ok: false, filed: 0, review: 0, applied: 0, downloads: 0, summary: '', error: readableError(err instanceof Error ? err.message : String(err)) }) as Awaited<ReturnType<typeof runPortalAgent>>);
    if (timer) clearTimeout(timer); // the final status below replaces any pending progress line
    const clash = !r.ok && r.error && REJECTED.test(r.error) ? await loginClash(utilityAccountId) : '';
    const failure = readableError(r.error ?? 'The portal agent stopped.') + clash;
    await db.utilityAccount.update({
      where: { id: utilityAccountId },
      data: r.ok ? { lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', lastSyncError: null } : { lastSyncStatus: 'FAILED', lastSyncError: failure },
    });
    await db.syncJob.update({ where: { id: syncJob.id }, data: { status: r.ok ? 'SUCCESS' : 'FAILED', completedAt: new Date(), statementsFound: r.filed + r.review, costUsd: r.costUsd ?? 0, error: r.ok ? null : failure, progress: r.ok ? (r.downloads ? downloadSummary(r) : (r.summary || 'Nothing new on the portal')).slice(0, 300) : null } });
    // The accounts that rode along: what this sign-in found for each.
    for (const o of also) {
      const filed = r.filedFor?.[o.id] ?? 0;
      const note = r.ok ? (filed ? `Downloaded ${filed} statement${filed === 1 ? '' : 's'} (signed in once with ${myLabel})` : `Nothing new (checked in the same sign-in as ${myLabel})`) : `Fetched with ${myLabel} (same login): ${failure}`;
      await db.utilityAccount.update({ where: { id: o.id }, data: r.ok ? { lastSyncedAt: new Date(), lastAgentRunAt: new Date(), lastSyncStatus: 'SUCCESS', lastSyncError: null } : { lastAgentRunAt: new Date(), lastSyncStatus: 'FAILED', lastSyncError: note.slice(0, 1000) } }).catch(() => {});
      await db.syncJob.updateMany({ where: { id: { in: alsoJobs }, utilityAccountId: o.id }, data: { status: r.ok ? 'SUCCESS' : 'FAILED', completedAt: new Date(), statementsFound: filed, error: r.ok ? null : note.slice(0, 1000), progress: r.ok ? note : null } }).catch(() => {});
    }
    const filedProps = new Set([...(r.filed ? [account.property.id] : [])]);
    const filedAlso = also.filter(o => (r.filedFor?.[o.id] ?? 0) > 0).map(o => o.id);
    if (filedAlso.length) for (const a of await db.utilityAccount.findMany({ where: { id: { in: filedAlso } }, select: { propertyId: true } })) filedProps.add(a.propertyId);
    for (const propertyId of filedProps) await insightQueue.add('generate', { propertyId }, { delay: 2000, attempts: 2 });
    console.log(`[ScrapeWorker] Portal agent ${account.providerName}: ${r.downloads} downloaded, ${r.filed} filed, ${r.review} to review; ${r.replayed ?? 0} steps replayed, ${r.aiSteps ?? 0} Claude turns, $${(r.costUsd ?? 0).toFixed(3)}${r.error ? ` — ${r.error}` : ''}`);
}

const worker = new Worker<ScrapeJobData>(
  'scrape',
  async (job: Job<ScrapeJobData>) => {
    const { utilityAccountId } = job.data;
    console.log(`[ScrapeWorker] Starting job for account ${utilityAccountId}`);

    // Work queued long ago with nobody waiting on it (jobs that piled up while
    // no worker ran) is out of date: the schedule queues a fresh one.
    if (!job.data.manual && Date.now() - job.timestamp > 12 * 3600_000) {
      console.log(`[ScrapeWorker] Skipping a stale job queued ${Math.round((Date.now() - job.timestamp) / 3600_000)}h ago for ${utilityAccountId}`);
      return;
    }
    if (job.data.syncJobId) {
      const mine = await db.syncJob.findUnique({ where: { id: job.data.syncJobId }, select: { createdAt: true, status: true } });
      // Cancelled while it waited in the queue.
      if (mine && mine.status !== 'PENDING') return;
      if (mine) {
        // A newer press for the same account replaces this one.
        const newer = await db.syncJob.findFirst({ where: { utilityAccountId, status: 'PENDING', createdAt: { gt: mine.createdAt } }, select: { id: true } });
        // A fetch of this account that finished after this press was made already did the work.
        const doneSince = await db.syncJob.findFirst({ where: { utilityAccountId, status: 'SUCCESS', completedAt: { gt: mine.createdAt } }, orderBy: { completedAt: 'desc' }, select: { progress: true } });
        if (newer || doneSince) {
          await db.syncJob.update({
            where: { id: job.data.syncJobId },
            data: newer
              ? { status: 'FAILED', completedAt: new Date(), error: 'Replaced by a newer Fetch for this account.', progress: null }
              : { status: 'SUCCESS', completedAt: new Date(), progress: `Already fetched moments ago — ${doneSince!.progress ?? 'done'}` },
          });
          return;
        }
      }
    }

    // Fetch the triggering account
    const account = await db.utilityAccount.findUnique({
      where: { id: utilityAccountId },
      include: { property: { select: { id: true, userId: true } } },
    });

    if (!account) throw new Error(`Utility account ${utilityAccountId} not found`);
    if (!account.syncEnabled) {
      console.log(`[ScrapeWorker] Sync disabled for ${utilityAccountId}, skipping`);
      // Pressed by hand: say why nothing happened instead of leaving it pending.
      if (job.data.manual) {
        const why = 'Syncing is turned off for this account (it is marked inactive). Turn it back on from the account to fetch statements.';
        if (job.data.syncJobId) await db.syncJob.update({ where: { id: job.data.syncJobId }, data: { status: 'FAILED', completedAt: new Date(), error: why, progress: null } }).catch(() => {});
        await db.utilityAccount.update({ where: { id: utilityAccountId }, data: { lastSyncStatus: 'FAILED', lastSyncError: why } });
      }
      return;
    }

    // ── No hand-written scraper for this provider: the portal agent ──────
    // Claude drives a browser through the portal. It costs a few cents a
    // run, so a scheduled run only goes when the account's next bill is due
    // by its own billing cycle, and never twice in a day. A "your bill is
    // ready" email (job.data.trigger = 'bill_posted') goes straight away; so
    // does Sync. An account that was set to read bills from Gmail goes to the
    // agent too once it has a portal login: most providers' emails only say
    // a bill is ready, and the statement itself is on the portal.
    if (job.data.forceAgent || !getScraperProvider(account.providerSlug) || (account.providerSlug === 'gmail-fallback' && account.usernameEnc)) {
      const last = await db.statement.findFirst({ where: { utilityAccountId }, orderBy: { statementDate: 'desc' }, select: { statementDate: true } });
      const cycle = billCycleDays(account.billingCadence);
      const notDueYet = last && Date.now() - last.statementDate.getTime() < (cycle - 3) * 86400000;
      const ranToday = account.lastAgentRunAt && Date.now() - account.lastAgentRunAt.getTime() < 20 * 3600000;
      // forceAgent: a built-in scraper's run for the whole login failed just now, so it is due.
      if (!job.data.manual && !job.data.forceAgent && job.data.trigger !== 'bill_posted' && (notDueYet || ranToday)) return;
      if (job.data.trigger === 'bill_posted' && ranToday && !job.data.manual) return;
      await agentJob(job, account);
      return; // never retried automatically: a retry could re-trigger a code or lock the login
    }

    // Decrypt credentials for the triggering account
    const username = account.usernameEnc ? decrypt(account.usernameEnc) : '';
    const password = account.passwordEnc ? decrypt(account.passwordEnc) : '';

    // ── Find all accounts for this user that share the same provider + login ──
    // When multiple utility accounts (e.g. 5 WM service addresses) use the same
    // username/password, we log in ONCE and scrape all of them in one session.
    const allProviderAccounts = await db.utilityAccount.findMany({
      where: {
        providerSlug: account.providerSlug,
        syncEnabled: true,
        property: { userId: account.property.userId },
      },
      include: { property: { select: { id: true, userId: true } } },
    });

    // Same username and same password: a different password under the same
    // username is a stale entry, and signing in with the wrong one would mark
    // (and lock) the others too.
    const sameCredAccounts = allProviderAccounts.filter(a => {
      if (a.id === utilityAccountId) return true;
      if (!a.usernameEnc || !a.passwordEnc) return false;
      try { return decrypt(a.usernameEnc) === username && decrypt(a.passwordEnc) === password; } catch { return false; }
    });

    console.log(
      `[ScrapeWorker] Scraping ${sameCredAccounts.length} ${account.providerSlug} account(s) in one session`
    );

    // Mark all of them PENDING
    await db.utilityAccount.updateMany({
      where: { id: { in: sameCredAccounts.map(a => a.id) } },
      data: { lastSyncStatus: 'PENDING' },
    });

    // Create sync job records
    const syncJobs = await Promise.all(
      sameCredAccounts.map(a =>
        a.id === utilityAccountId && job.data.syncJobId
          ? db.syncJob.update({ where: { id: job.data.syncJobId }, data: { status: 'PENDING', startedAt: new Date(), progress: `Signing in to ${account.providerName} (built-in connector)` } })
          : db.syncJob.create({ data: { utilityAccountId: a.id, status: 'PENDING', startedAt: new Date() } })
      )
    );

    try {
      const scraper = getScraperProvider(account.providerSlug);
      if (!scraper) throw new Error(`No scraper found for provider: ${account.providerSlug}`);

      // Pass all tracked account numbers so the scraper only drills into those,
      // skipping any WM addresses the user hasn't added to Sollux.
      const accountNumbers = sameCredAccounts
        .map(a => (a.accountNumberEnc ? decrypt(a.accountNumberEnc) : null))
        .filter(Boolean) as string[];

      // Build a per-account-number map of latest statement dates.
      // Each account gets its own cutoff so a brand-new account (zero statements)
      // is never blocked by another account's already-stored date.
      const latestStmts = await db.statement.findMany({
        where: {
          utilityAccountId: { in: sameCredAccounts.map(a => a.id) },
          pdfS3Key: { not: null },   // only count statements where PDF was actually stored
        },
        orderBy: { statementDate: 'desc' },
        select: { utilityAccountId: true, statementDate: true },
      });

      // latestStatementDates: accountNumber → most recent statement date (for new-account guard)
      // knownStatementDates:  accountNumber → ALL stored dates as YYYY-MM-DD (for exact-date dedup)
      const latestStatementDates: Record<string, Date> = {};
      const knownStatementDates: Record<string, string[]> = {};
      for (const acct of sameCredAccounts) {
        const acctNum = acct.accountNumberEnc ? decrypt(acct.accountNumberEnc) : null;
        if (!acctNum) continue;
        const acctStmts = latestStmts.filter(s => s.utilityAccountId === acct.id);
        if (acctStmts.length > 0) {
          latestStatementDates[acctNum] = acctStmts[0].statementDate; // already sorted desc
          knownStatementDates[acctNum] = acctStmts.map(s =>
            s.statementDate.toISOString().slice(0, 10)   // YYYY-MM-DD
          );
        }
      }

      // Legacy single-date field: the global maximum across all accounts (for scrapers
      // that don't yet support per-account maps, e.g. single-account scrapers).
      const latestStatementDate = latestStmts.length > 0 ? latestStmts[0].statementDate : undefined;

      const credentials = { username, password, accountNumbers, latestStatementDate, latestStatementDates, knownStatementDates };
      const result = await scraper.run(credentials, utilityAccountId);

      if (!result.success) throw new Error(result.error || 'Scraper returned failure');

      // ── Distribute statements to the correct utility account by account number ──
      let totalInserted = 0;

      for (const acct of sameCredAccounts) {
        const acctNum = acct.accountNumberEnc ? decrypt(acct.accountNumberEnc) : null;
        let statementsInserted = 0;
        let paymentsInserted = 0;

        // Match statements to this utility account
        let matchingStmts: typeof result.statements;
        if (acctNum) {
          const filtered = result.statements.filter(stmt => {
            // Check rawData.accountNumber first; fall back to rsInfoProId for providers
            // that store their account identifier under a different key (e.g. Republic Services)
            const stmtAcctNum = (stmt.rawData?.accountNumber ?? stmt.rawData?.rsInfoProId) as string | undefined;
            if (!stmtAcctNum) return sameCredAccounts.length === 1; // single-account: take all
            const a = normalizeAcct(stmtAcctNum);
            const b = normalizeAcct(acctNum);
            // Strict match: exact OR one is a suffix of the other.
            // (RS stores "3-04670-041160" but API returns "4670041160" — same account, suffix match.)
            // Substring `includes` was too permissive — when account A's number contains
            // digit subsequences of account B's number, it falsely matched.
            if (a === b) return true;
            if (a.length >= 6 && b.endsWith(a)) return true;
            if (b.length >= 6 && a.endsWith(b)) return true;
            return false;
          });
          // Debug: log filter result so cross-account contamination is visible
          if (filtered.length !== result.statements.length) {
            console.log(`[ScrapeWorker] Account ${acct.accountNumber} filter: ${filtered.length}/${result.statements.length} statements kept (b=${normalizeAcct(acctNum)})`);
          }
          // If the account number filter matched nothing but this is the only account with
          // these credentials, the stored account number likely has a format mismatch
          // (e.g. RS uses infoProId "4670038334" but user stored "3-04670-038334").
          // Fall back to assigning all statements rather than silently importing nothing.
          if (filtered.length === 0 && sameCredAccounts.length === 1) {
            console.log(`[ScrapeWorker] Account number filter matched 0 statements for single account ${acct.id} — bypassing filter (format mismatch)`);
            matchingStmts = result.statements;
          } else {
            matchingStmts = filtered;
          }
        } else {
          // No account number stored on this Sollux account:
          // only assign statements to the account that triggered this sync job.
          // (If multiple accounts share the same creds and none has a stored number,
          //  assigning ALL statements to every account would create duplicates.)
          matchingStmts = sameCredAccounts.length === 1 || acct.id === utilityAccountId
            ? result.statements
            : [];
        }

        for (const stmt of matchingStmts) {
          let pdfS3Key: string | undefined;
          if (stmt.pdfBuffer && stmt.pdfFilename) {
            const key = buildStatementKey(
              acct.property.userId,
              acct.property.id,
              acct.id,
              stmt.statementDate,
              stmt.pdfFilename
            );
            pdfS3Key = await uploadDocument(key, stmt.pdfBuffer);
          }

          // A bill is its billing period, not its issue month: a drifting
          // cycle puts two bills in one month, and the plain month lookup this
          // used to be overwrote the first with the second. Match the period
          // when the scraper reports one; the month fallback still exists for
          // scrapers that do not (and for account-summary rows arriving with
          // today's date), but it may only claim rows without a real period —
          // a row with one is identified by it.
          let existing = null;
          if (stmt.billingPeriodStart) {
            const window = 7 * 24 * 60 * 60 * 1000;
            existing = await db.statement.findFirst({
              where: {
                utilityAccountId: acct.id,
                billingPeriodStart: {
                  gte: new Date(stmt.billingPeriodStart.getTime() - window),
                  lte: new Date(stmt.billingPeriodStart.getTime() + window),
                },
              },
            });
          }
          if (!existing) {
            const monthStart = new Date(stmt.statementDate.getFullYear(), stmt.statementDate.getMonth(), 1);
            const monthEnd = new Date(stmt.statementDate.getFullYear(), stmt.statementDate.getMonth() + 1, 0, 23, 59, 59);
            existing = await db.statement.findFirst({
              where: {
                utilityAccountId: acct.id,
                statementDate: { gte: monthStart, lte: monthEnd },
                ...(stmt.billingPeriodStart ? { billingPeriodStart: null } : {}),
              },
              orderBy: { createdAt: 'asc' }, // prefer the oldest (first scraped = real statement)
            });
          }

          const isPaid = stmt.rawData?.isPaid === true;
          const amountPaid = isPaid && stmt.amountDue ? stmt.amountDue : undefined;

          // balance = total amount currently owed (current charge + any past due).
          // Prefer the dedicated field from the scraper; fall back to totalDue / amountDue.
          const rawBalance = (stmt.rawData?.accountBalance ?? stmt.rawData?.totalDue) as number | undefined;
          const balance = rawBalance != null ? rawBalance
            : stmt.balance != null ? stmt.balance
            : undefined;

          if (!existing) {
            await db.statement.create({
              data: {
                utilityAccountId: acct.id,
                statementDate: stmt.statementDate,
                dueDate: stmt.dueDate,
                billingPeriodStart: stmt.billingPeriodStart,
                billingPeriodEnd: stmt.billingPeriodEnd,
                amountDue: stmt.amountDue,
                amountPaid,
                balance,
                usageValue: stmt.usageValue,
                usageUnit: stmt.usageUnit,
                ratePlan: stmt.ratePlan,
                pdfS3Key,
                rawDataJson: stmt.rawData as Prisma.InputJsonValue,
              },
            });
            statementsInserted++;
            totalInserted++;
          } else {
            // Update existing statement if:
            //  - paid status changed (user paid between syncs)
            //  - rawData has new/better info
            //  - existing is a stub (no PDF) but we now have a real PDF
            const wasUnpaid = !existing.amountPaid;
            const rawChanged = JSON.stringify(existing.rawDataJson) !== JSON.stringify(stmt.rawData);
            const isStubUpgrade = !!pdfS3Key && !existing.pdfS3Key;

            if ((isPaid && wasUnpaid) || rawChanged || isStubUpgrade) {
              await db.statement.update({
                where: { id: existing.id },
                data: {
                  ...(isPaid && wasUnpaid ? { amountPaid } : {}),
                  rawDataJson: stmt.rawData as Prisma.InputJsonValue,
                  // Update rich fields when upgrading from a stub or when scraper got better data
                  ...(stmt.dueDate ? { dueDate: stmt.dueDate } : {}),
                  ...(stmt.amountDue ? { amountDue: stmt.amountDue } : {}),
                  ...(balance != null ? { balance } : {}),
                  ...(stmt.billingPeriodStart ? { billingPeriodStart: stmt.billingPeriodStart } : {}),
                  ...(stmt.billingPeriodEnd ? { billingPeriodEnd: stmt.billingPeriodEnd } : {}),
                  ...(stmt.usageValue != null ? { usageValue: stmt.usageValue } : {}),
                  ...(stmt.usageUnit ? { usageUnit: stmt.usageUnit } : {}),
                  ...(stmt.ratePlan ? { ratePlan: stmt.ratePlan } : {}),
                  // Key: attach the real PDF when upgrading a stub
                  ...(isStubUpgrade ? { pdfS3Key } : {}),
                },
              });
              if (isStubUpgrade) {
                console.log(`[ScrapeWorker] Upgraded stub → real PDF for statement ${existing.id} (${stmt.statementDate.toISOString().slice(0, 10)})`);
                statementsInserted++;
                totalInserted++;
              }
            }
          }
        }

        // Payments routing:
        //  - If the scraped payment carries an accountNumber, route it to THAT account
        //    (WM scrapes Payment History per-account, so each payment is account-specific).
        //  - Otherwise (legacy single-account scrapers) fall back to assigning all payments
        //    to the triggering account only.
        const paymentsForAcct = acctNum
          ? result.payments.filter(pmt => {
              if (!pmt.accountNumber) {
                // No account tag → only the triggering account takes the payment, to avoid duplicates
                return acct.id === utilityAccountId;
              }
              return normalizeAcct(pmt.accountNumber) === normalizeAcct(acctNum);
            })
          : (acct.id === utilityAccountId ? result.payments : []);

        if (paymentsForAcct.length > 0) {
          for (const pmt of paymentsForAcct) {
            // Wrap amount in Prisma.Decimal explicitly. Passing a raw JS number lets
            // Prisma serialize it via a path where some IEEE-754 values (e.g. 961.57)
            // do NOT compare equal to the stored NUMERIC(10,2) value, so dedup misses
            // and a fresh copy gets inserted on every sync run. Using Decimal ensures
            // string-based exact comparison.
            // Dedup also includes confirmationNumber when present — without it, multiple
            // legit same-day same-amount payments (different transactions) would collide.
            const amtDecimal = new Prisma.Decimal(String(pmt.amount));
            const existing = await db.payment.findFirst({
              where: {
                utilityAccountId: acct.id,
                paymentDate: pmt.paymentDate,
                amount: amtDecimal,
                ...(pmt.confirmationNumber ? { confirmationNumber: pmt.confirmationNumber } : {}),
              },
            });
            // Helper: is this a "bad" placeholder value scraped incorrectly?
            const isBadConfirmation = (s?: string | null) =>
              !s || /^(number|n\/a|none|null|undefined)$/i.test(s.trim());
            // Single generic words are not useful payment methods
            const isBadMethod = (s?: string | null) =>
              !s || /^(online|automatic|checking|debit|credit|bank|payment)$/i.test(s.trim());

            if (!existing) {
              await db.payment.create({
                data: {
                  utilityAccountId: acct.id,
                  amount: pmt.amount,
                  paymentDate: pmt.paymentDate,
                  confirmationNumber: isBadConfirmation(pmt.confirmationNumber) ? null : pmt.confirmationNumber,
                  paymentMethod: isBadMethod(pmt.paymentMethod) ? null : pmt.paymentMethod,
                  status: 'PAID',
                },
              });
              paymentsInserted++;
            } else {
              // Update if we now have better data (confirmation # was missing or bad before)
              const needsUpdate =
                (isBadConfirmation(existing.confirmationNumber) && !isBadConfirmation(pmt.confirmationNumber)) ||
                (isBadMethod(existing.paymentMethod) && !isBadMethod(pmt.paymentMethod));
              if (needsUpdate) {
                await db.payment.update({
                  where: { id: existing.id },
                  data: {
                    confirmationNumber: isBadConfirmation(pmt.confirmationNumber) ? existing.confirmationNumber : pmt.confirmationNumber,
                    paymentMethod: isBadMethod(pmt.paymentMethod) ? null : pmt.paymentMethod,
                  },
                });
              }
            }
          }
        }

        // A sync that signed in but found nothing is only a success while the
        // account is inside its billing cycle. Past it, the portal most likely
        // changed (a moved page, a selector that no longer matches) and the
        // account has gone quiet: SDG&E sat at SUCCESS for 411 days with no
        // bill (#191). Say so, where the owner and the auditor both look.
        let silentNote: string | null = null;
        if (matchingStmts.length === 0) {
          const limit = acct.escrowLoanId ? null : overdueAfterDays(acct.billingCadence);
          const last = await db.statement.findFirst({ where: { utilityAccountId: acct.id }, orderBy: { statementDate: 'desc' }, select: { statementDate: true } });
          const days = last ? Math.floor((Date.now() - last.statementDate.getTime()) / 86_400_000) : null;
          if (limit != null && days != null && days > limit) {
            silentNote = `Signed in, but the portal showed no bills — none since ${last!.statementDate.toISOString().slice(0, 10)} (${days} days). The provider's site may have changed; import the latest bill by hand meanwhile.`;
          }
        }

        await db.utilityAccount.update({
          where: { id: acct.id },
          data: silentNote
            ? { lastSyncedAt: new Date(), lastSyncStatus: 'FAILED', lastSyncError: silentNote }
            : { lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', lastSyncError: null },
        });

        const syncJobForAcct = syncJobs.find(j => j.utilityAccountId === acct.id);
        if (syncJobForAcct) {
          await db.syncJob.update({
            where: { id: syncJobForAcct.id },
            data: { status: silentNote ? 'FAILED' : 'SUCCESS', completedAt: new Date(), statementsFound: statementsInserted, paymentsFound: paymentsInserted, error: silentNote, progress: silentNote ? null : statementsInserted ? `${statementsInserted} new statement${statementsInserted === 1 ? '' : 's'} (built-in connector)` : 'Nothing new on the portal (built-in connector)' },
          });
        }

        // Queue insights for this property
        await insightQueue.add('generate', { propertyId: acct.property.id }, { delay: 2000, attempts: 2 });
      }

      console.log(`[ScrapeWorker] Done: ${totalInserted} new statements across ${sameCredAccounts.length} account(s)`);

    } catch (err) {
      const raw = readableError(err instanceof Error ? err.message : 'Unknown error');
      const message = raw + (REJECTED.test(raw) ? await loginClash(utilityAccountId) : '');
      console.error(`[ScrapeWorker] Error for ${utilityAccountId}:`, raw);

      // Mark all same-cred accounts failed
      await db.utilityAccount.updateMany({
        where: { id: { in: sameCredAccounts.map(a => a.id) } },
        data: { lastSyncStatus: 'FAILED', lastSyncError: message },
      });

      for (const syncJob of syncJobs) {
        await db.syncJob.update({
          where: { id: syncJob.id },
          data: { status: 'FAILED', completedAt: new Date(), error: message, progress: null },
        });
      }

      // The built-in scraper broke (the site changed, or it blocks automation):
      // the portal agent reads the page as it is now. This account runs here;
      // the others on the same login are queued for the agent too.
      if (!job.data.forceAgent && account.usernameEnc && account.passwordEnc && websiteFor(account)) {
        console.log(`[ScrapeWorker] ${account.providerName} scraper failed (${message}) — handing over to the portal agent`);
        for (const other of sameCredAccounts.filter(a => a.id !== utilityAccountId)) {
          await scrapeQueue.add('scrape', { utilityAccountId: other.id, forceAgent: true }, { jobId: `agent-fallback-${other.id}-${new Date().toISOString().slice(0, 10)}`, removeOnComplete: { count: 100 }, removeOnFail: { count: 50 } }).catch(() => {});
        }
        await agentJob({ ...job, data: { ...job.data, forceAgent: true } } as Job<ScrapeJobData>, account);
        return;
      }

      throw err;
    }
  },
  {
    connection: createWorkerConnection(),
    // Each portal-agent job is a Chrome; inside the API (RUN_WORKERS_IN_API) one at a time.
    concurrency: Number(process.env.SCRAPE_CONCURRENCY) || (process.env.RUN_WORKERS_IN_API === 'true' ? 1 : 3),
    ...workerTuning,
  }
);

// The jobs running right now, so a shutdown can hand them back (handOffActiveJobs).
const running = new Map<string, ScrapeJobData>();
worker.on('active', job => { jobStarted(); if (job.id) running.set(job.id, job.data); });
worker.on('completed', job => {
  jobEnded(); if (job.id) running.delete(job.id);
  console.log(`[ScrapeWorker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  jobEnded(); if (job?.id) running.delete(job.id);
  console.error(`[ScrapeWorker] Job ${job?.id} failed:`, err.message);
});

guardWorker('ScrapeWorker', worker);

export default worker;

/**
 * Render stops the worker for every deploy: a SIGTERM, then a kill 30 seconds
 * later — too soon for a portal fetch to finish. Stop taking jobs, put each
 * running fetch back at the front of the queue (same sync job, so its row
 * says what happened and carries on), and let the new worker start it again.
 */
export async function handOffActiveJobs(): Promise<number> {
  await worker.pause(true).catch(() => {});
  let n = 0;
  for (const [id, data] of running) {
    await scrapeQueue.add('scrape', { ...data }, { jobId: `resume-${data.utilityAccountId}-${Date.now()}`, lifo: true, removeOnComplete: { count: 100 }, removeOnFail: { count: 50 } }).catch(() => {});
    if (data.syncJobId) await db.syncJob.update({ where: { id: data.syncJobId }, data: { progress: 'Paused for an app update — starts again in a minute' } }).catch(() => {});
    console.log(`[ScrapeWorker] Handing job ${id} (${data.utilityAccountId}) back to the queue for the next worker`);
    n++;
  }
  return n;
}
