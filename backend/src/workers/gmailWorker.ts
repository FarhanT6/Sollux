import { Worker, Job } from 'bullmq';
import { parseGmailForUser } from '../parsers/gmailParser';
import { guardWorker } from './redisGuard';
import { createWorkerConnection, workerTuning } from './queues';

interface GmailJobData {
  userId: string;
}

const worker = new Worker<GmailJobData>(
  'gmail',
  async (job: Job<GmailJobData>) => {
    console.log(`[GmailWorker] Parsing Gmail for user ${job.data.userId}`);
    await parseGmailForUser(job.data.userId);
  },
  { connection: createWorkerConnection(), concurrency: 2, ...workerTuning }
);

worker.on('completed', job => console.log(`[GmailWorker] Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`[GmailWorker] Job ${job?.id} failed:`, err.message));
guardWorker('GmailWorker', worker);

export default worker;
