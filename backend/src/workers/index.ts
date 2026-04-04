import 'dotenv/config';
import './scrapeWorker';
import './insightWorker';
import { scrapeQueue, insightQueue } from './queues';
import { db } from '../config/db';

console.log('🔧 Sollux Workers started');

// ── Scheduled Jobs ────────────────────────────────────────
// Run all scrapes every 6 hours
async function scheduleAllScrapes() {
  const accounts = await db.utilityAccount.findMany({
    where: { syncEnabled: true },
    select: { id: true },
  });

  console.log(`[Scheduler] Queuing ${accounts.length} scrape jobs`);

  for (const account of accounts) {
    await scrapeQueue.add(
      'scrape',
      { utilityAccountId: account.id },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
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
