import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const scrapeQueue = new Queue('scrape', { connection });
export const insightQueue = new Queue('insights', { connection });
export const notificationQueue = new Queue('notifications', { connection });
export const gmailQueue = new Queue('gmail', { connection });

export { connection as redisConnection };
