import { Queue } from 'bullmq';
import IORedis from 'ioredis';

function makeConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const conn = new IORedis(url, {
    maxRetriesPerRequest: null,
    // Upstash uses rediss:// (TLS); explicitly enable on those URLs so the
    // connection works on Render even when the cert chain isn't cached yet.
    ...(url.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
  });
  conn.on('error', (err) => console.error('[Redis] connection error:', err.message));
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

// Keep backward-compat export for anything that imported redisConnection directly.
export const redisConnection = makeConnection();
