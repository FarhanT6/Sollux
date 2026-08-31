import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/** Errors that will not clear by reconnecting — retrying only spends quota. */
const FATAL_REDIS = /max requests limit|max daily request|quota|WRONGPASS|NOAUTH|invalid password/i;

/**
 * Log at most one line per connection per minute.
 *
 * A refusing Redis produces an error on every reconnect attempt across every
 * connection, which buries the rest of the log. It also matters *what* is
 * logged: ioredis attaches the failing command to the error, and for an AUTH
 * failure that command carries the Redis password — printing the error object
 * puts the credential in Render's logs. Only the message is ever logged.
 */
function throttledLogger(label: string) {
  let last = 0;
  return (message: string) => {
    const now = Date.now();
    if (now - last < 60_000) return;
    last = now;
    console.error(`[${label}] ${message}`);
  };
}

function makeConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const log = throttledLogger('Redis');
  let giveUp = false;

  const conn = new IORedis(url, {
    maxRetriesPerRequest: null,
    // Upstash uses rediss:// (TLS); explicitly enable on those URLs so the
    // connection works on Render even when the cert chain isn't cached yet.
    ...(url.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    /**
     * ioredis retries about every 50ms by default. Against a provider that
     * rejects every command and bills each attempt, that is thousands of
     * wasted requests a minute — the reconnect loop makes an exhausted quota
     * worse rather than waiting for it to reset. Back off to a minute, and
     * stop entirely once the failure is one reconnecting cannot fix.
     */
    retryStrategy(times: number) {
      if (giveUp) return null;
      return Math.min(1000 * 2 ** Math.min(times, 6), 60_000);
    },
    reconnectOnError(err: Error) {
      if (FATAL_REDIS.test(err.message)) {
        giveUp = true;
        log(`giving up reconnecting: ${err.message}`);
        return false;
      }
      return true;
    },
  });

  // Never log the error object itself — see throttledLogger.
  conn.on('error', (err: Error) => {
    if (FATAL_REDIS.test(err.message)) giveUp = true;
    log(`connection error: ${err.message}`);
  });
  return conn;
}

// Each Queue and Worker should use its own IORedis instance — BullMQ performs
// blocking BRPOPLPUSH-style operations on worker connections that are
// incompatible with the non-blocking commands queues issue.
export const scrapeQueue = new Queue('scrape', { connection: makeConnection() });
export const insightQueue = new Queue('insights', { connection: makeConnection() });
export const notificationQueue = new Queue('notifications', { connection: makeConnection() });
export const gmailQueue = new Queue('gmail', { connection: makeConnection() });
export const driveImportQueue = new Queue('drive-import', { connection: makeConnection() });

export { makeConnection as createWorkerConnection };

/**
 * Options every Worker should spread in, tuned for a metered Redis.
 *
 * BullMQ's defaults assume Redis is free to talk to: a 5-second blocking poll
 * and a 30-second stalled-job check mean one idle worker issues about 17,000
 * requests a day, and four of them clear two million a month against Upstash's
 * 500,000 free-tier cap — without a single job ever being processed.
 *
 * Lengthening the blocking poll costs nothing in latency. The call returns the
 * moment a job is pushed; drainDelay only bounds how long it waits when the
 * queue stays empty. The stalled check is a recovery path for jobs orphaned by
 * a crashed worker, so running it every five minutes rather than every thirty
 * seconds delays recovery, not normal work.
 */
export const workerTuning = {
  drainDelay: 60,
  stalledInterval: 5 * 60_000,
} as const;

// Keep backward-compat export for anything that imported redisConnection directly.
export const redisConnection = makeConnection();
