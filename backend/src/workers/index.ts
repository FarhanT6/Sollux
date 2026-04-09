import 'dotenv/config';
import './scrapeWorker';
import './insightWorker';
import './gmailWorker';
import { scrapeQueue, insightQueue } from './queues';
import { db } from '../config/db';
import { decrypt } from '../crypto/encrypt';

console.log('🔧 Sollux Workers started');

// ── Scheduled Jobs ────────────────────────────────────────
// Run all scrapes every 6 hours.
// Accounts that share the same provider + login are grouped — only ONE job is
// queued per credential group. The worker logs in once and handles all of them.
async function scheduleAllScrapes() {
  const accounts = await db.utilityAccount.findMany({
    where: { syncEnabled: true },
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

// Run initial scrape on startup (after 30s delay)
setTimeout(scheduleAllScrapes, 30_000);
