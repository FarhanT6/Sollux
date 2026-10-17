import 'dotenv/config';
import { startHeartbeat } from './heartbeat';
import { runAutopay } from '../services/rentCollection';
import '../config/playwrightPath';
import './scrapeWorker';
import './insightWorker';
import './gmailWorker';
import './driveImportWorker';
import { scrapeQueue, insightQueue, gmailQueue } from './queues';
import { db } from '../config/db';
import { runNoticeReminders, importEarlierNotices } from '../services/noticeTracker';
import { detachEmailPrintouts } from '../services/emailPrintouts';
import { decrypt } from '../crypto/encrypt';
import { runDailyBalanceSnapshot } from './balanceSnapshotWorker';
import { syncAllWatchedAccounts } from '../services/transactionMatchService';
import { applyDueRentIncreases, rolloverExpiredLeases, accrueOverdueRent } from './rentIncreaseWorker';
import { assessLateFees } from '../services/rentCharges';

console.log('🔧 Sollux Workers started');
// Inside the API process (RUN_WORKERS_IN_API) the heartbeat says so.
startHeartbeat(process.env.RUN_WORKERS_IN_API === 'true' ? 'sollux-api' : 'sollux-workers');

// ── Scheduled Jobs ────────────────────────────────────────
// Run all scrapes every 6 hours.
// Accounts that share the same provider + login are grouped — only ONE job is
// queued per credential group. The worker logs in once and handles all of them.
async function scheduleAllScrapes() {
  const accounts = await db.utilityAccount.findMany({
    // A Gmail-read account is synced only once it has a portal login (the
    // portal agent fetches its statements); without one it ran the empty
    // fallback scraper and "succeeded" with nothing, forever (#191).
    where: { syncEnabled: true, OR: [{ providerSlug: { not: 'gmail-fallback' } }, { usernameEnc: { not: null } }] },
    include: { property: { select: { userId: true } } },
  });

  // Build credential groups: key = userId:providerSlug:username
  const seen = new Set<string>();
  const toQueue: string[] = [];

  for (const acct of accounts) {
    let username = '';
    try { username = acct.usernameEnc ? decrypt(acct.usernameEnc) : ''; } catch { /* skip */ }
    const groupKey = `${acct.property.userId}:${acct.providerSlug}:${username}`;
    if (!seen.has(groupKey)) {
      seen.add(groupKey);
      toQueue.push(acct.id); // one representative per credential group
    }
  }

  console.log(`[Scheduler] Queuing ${toQueue.length} scrape job(s) (${accounts.length} accounts, deduped by login)`);

  for (const accountId of toQueue) {
    await scrapeQueue.add(
      'scrape',
      { utilityAccountId: accountId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 120000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      }
    );
  }
}

// Run all insight generations nightly
async function scheduleAllInsights() {
  const properties = await db.property.findMany({ select: { id: true } });
  console.log(`[Scheduler] Queuing ${properties.length} insight jobs`);

  for (const property of properties) {
    await insightQueue.add(
      'generate',
      { propertyId: property.id },
      { attempts: 2, removeOnComplete: { count: 50 } }
    );
  }
}

// Run scrapes every 6 hours
setInterval(scheduleAllScrapes, 6 * 60 * 60 * 1000);

// Apply any due scheduled rent increases — on startup, then once a day.
async function runLeaseMaintenance() {
  await applyDueRentIncreases().catch(err => console.warn('[RentIncrease] run failed:', err));
  await rolloverExpiredLeases().catch(err => console.warn('[LeaseRollover] run failed:', err));
  // Last month into arrears first, then this month's late fees.
  await accrueOverdueRent().catch(err => console.warn('[Arrears] run failed:', err));
  await assessLateFees().catch(err => console.warn('[LateFees] run failed:', err));
}
runLeaseMaintenance();
setInterval(runLeaseMaintenance, 24 * 60 * 60 * 1000);

// Run Plaid balance snapshots every night at 11:55 PM
(function scheduleDailyBalanceSnapshot() {
  const now = new Date();
  const next = new Date();
  next.setHours(23, 55, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    runDailyBalanceSnapshot();
    setInterval(runDailyBalanceSnapshot, 24 * 60 * 60 * 1000);
  }, next.getTime() - now.getTime());
  console.log(`[BalanceSnapshot] Scheduled — next run at ${next.toLocaleTimeString()}`);
})();

// Run insights nightly at 2am
const now = new Date();
const nextRun = new Date();
nextRun.setHours(2, 0, 0, 0);
if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
const msUntilNightly = nextRun.getTime() - now.getTime();

setTimeout(() => {
  scheduleAllInsights();
  setInterval(scheduleAllInsights, 24 * 60 * 60 * 1000);
}, msUntilNightly);

// The bookkeeper goes over every account, bill, policy and loan nightly at
// 5am (after the 2am insights and any overnight imports) and raises what
// needs a hand as insights. One job; it walks every owner itself.
(function scheduleBookkeeper() {
  const queueIt = () => insightQueue.add('bookkeeper', {}, { attempts: 2, removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } })
    .catch(err => console.warn('[Bookkeeper] could not queue:', err instanceof Error ? err.message : err));
  const first = new Date();
  first.setHours(5, 0, 0, 0);
  if (first <= new Date()) first.setDate(first.getDate() + 1);
  setTimeout(() => { queueIt(); setInterval(queueIt, 24 * 60 * 60 * 1000); }, first.getTime() - Date.now());
  console.log(`[Bookkeeper] Scheduled — next run at ${first.toLocaleString()}`);
})();

// Rent autopay: each morning at 9am Pacific (16:00 UTC), tenants enrolled in
// the portal's autopay are charged what the month still owes, once, from the
// rent's due day (services/rentCollection.ts).
(function scheduleAutopay() {
  const run = () => runAutopay()
    .then(r => console.log(`[Autopay] ${r.charged} charged, ${r.skipped} not due or nothing owed`))
    .catch(err => console.warn('[Autopay] failed:', err instanceof Error ? err.message : err));
  const first = new Date();
  first.setUTCHours(16, 0, 0, 0);
  if (first <= new Date()) first.setUTCDate(first.getUTCDate() + 1);
  setTimeout(() => { run(); setInterval(run, 24 * 60 * 60 * 1000); }, first.getTime() - Date.now());
  console.log(`[Autopay] Scheduled — next run at ${first.toISOString()}`);
})();

// Shut-off and cancellation notices: close the ones payments now cover and
// remind about the rest, every morning at 8am Pacific (15:00 UTC).
(function scheduleNoticeReminders() {
  const run = () => runNoticeReminders()
    .then(r => console.log(`[Notices] ${r.reminded} reminded, ${r.resolved} resolved by payments`))
    .catch(err => console.warn('[Notices] reminders failed:', err instanceof Error ? err.message : err));
  const first = new Date();
  first.setUTCHours(15, 0, 0, 0);
  if (first <= new Date()) first.setUTCDate(first.getUTCDate() + 1);
  setTimeout(() => { run(); setInterval(run, 24 * 60 * 60 * 1000); }, first.getTime() - Date.now());
  console.log(`[Notices] Reminders scheduled — next run at ${first.toISOString()}`);
  // Printouts of bill emails saved as statement PDFs before email notices
  // were kept as figures only: taken off (once per bill).
  detachEmailPrintouts()
    .then(r => r.detached && console.log(`[Import] ${r.detached} email printout(s) taken off statements (${r.checked} checked)`))
    .catch(err => console.warn('[Import] email printouts not checked:', err instanceof Error ? err.message : err));
  // Notices read before they were tracked: brought in once (idempotent).
  importEarlierNotices()
    .then(r => r.created && console.log(`[Notices] ${r.created} earlier notice(s) brought into the tracker, ${r.open} still open`))
    .catch(err => console.warn('[Notices] earlier notices not imported:', err instanceof Error ? err.message : err));
})();

// The inbox agent reads every connected mailbox nightly at 1am, ahead of
// the 2am insights and 5am bookkeeper, so what it files is in their view.
(function scheduleInboxAgent() {
  const queueIt = () => gmailQueue.add('inbox-all', {}, { attempts: 1, removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } })
    .catch(err => console.warn('[InboxAgent] could not queue:', err instanceof Error ? err.message : err));
  const first = new Date();
  first.setHours(1, 0, 0, 0);
  if (first <= new Date()) first.setDate(first.getDate() + 1);
  setTimeout(() => { queueIt(); setInterval(queueIt, 24 * 60 * 60 * 1000); }, first.getTime() - Date.now());
  console.log(`[InboxAgent] Scheduled — next run at ${first.toLocaleString()}`);
})();

// Bank transactions sync nightly at 12:30am, so rent received and loan and
// bill payments made yesterday are matched before the morning. Until now
// they synced only when someone pressed Sync.
(function scheduleBankSync() {
  const run = async () => {
    const owners = await db.plaidItem.findMany({ where: { isActive: true }, distinct: ['userId'], select: { userId: true } }).catch(() => []);
    for (const { userId } of owners) {
      await syncAllWatchedAccounts(userId).catch(err => console.warn('[BankSync]', userId, err instanceof Error ? err.message : err));
    }
  };
  const first = new Date();
  first.setHours(0, 30, 0, 0);
  if (first <= new Date()) first.setDate(first.getDate() + 1);
  setTimeout(() => { run(); setInterval(run, 24 * 60 * 60 * 1000); }, first.getTime() - Date.now());
})();

// NOTE: Removed startup auto-scrape. Scrapes run every 6 hours via setInterval above,
// or on demand via the Sync button / POST /api/utilities/:id/sync.

// ── Startup cleanup: fix accounts/jobs stuck at PENDING from a previous crash ──
// If the worker process is killed mid-job (SIGINT, OOM, crash), accounts remain
// forever in PENDING state and the UI shows "Syncing..." indefinitely.
// On every worker restart, flip those stale records to FAILED so the UI is honest.
(async () => {
  try {
    const stuckAccounts = await db.utilityAccount.updateMany({
      where: { lastSyncStatus: 'PENDING' },
      data: { lastSyncStatus: 'FAILED', lastSyncError: 'Sync interrupted — worker restarted. Click Sync to retry.' },
    });
    const stuckJobs = await db.syncJob.updateMany({
      where: { status: 'PENDING', completedAt: null },
      data: { status: 'FAILED', completedAt: new Date(), error: 'Job interrupted (worker restarted)' },
    });
    if (stuckAccounts.count > 0 || stuckJobs.count > 0) {
      console.log(`[Startup] Cleared ${stuckAccounts.count} stuck account(s) and ${stuckJobs.count} stuck job(s) from previous crash`);
    }
  } catch (err) {
    console.warn('[Startup] Could not clean stuck sync state:', err);
  }
})();

// ── One-time cleanup: clear bad placeholder confirmation numbers ─────────────
(async () => {
  try {
    const confResult = await db.payment.updateMany({
      where: { confirmationNumber: { in: ['Number', 'number', 'N/A', 'None', 'null', 'undefined'] } },
      data: { confirmationNumber: null },
    });
    if (confResult.count > 0) {
      console.log(`[Cleanup] Cleared ${confResult.count} bad confirmationNumber value(s)`);
    }
    // Also clear overly generic payment method values captured by old regex
    const methodResult = await db.payment.updateMany({
      where: { paymentMethod: { in: ['Online', 'online', 'Automatic', 'automatic', 'Checking', 'checking', 'Debit', 'debit'] } },
      data: { paymentMethod: null },
    });
    if (methodResult.count > 0) {
      console.log(`[Cleanup] Cleared ${methodResult.count} bad paymentMethod value(s)`);
    }
  } catch (err) {
    console.warn('[Cleanup] Could not clean bad confirmationNumbers:', err);
  }
})();
