import { Worker, Job } from 'bullmq';
import { runInboxAgent, runInboxAgentForEveryone } from '../ai/inboxAgent';
import { guardWorker } from './redisGuard';
import { withAiContext } from '../ai/meter';
import { createWorkerConnection, workerTuning } from './queues';

interface GmailJobData {
  userId?: string;
  tokenId?: string;
}

// 'parse' reads one owner's mailboxes (Sync now); 'inbox-all' is the nightly
// run over every owner with a connected mailbox.
const worker = new Worker<GmailJobData>(
  'gmail',
  async (job: Job<GmailJobData>) => {
    if (job.name === 'inbox-all') return runInboxAgentForEveryone();
    if (!job.data.userId) return;
    console.log(`[GmailWorker] Inbox agent for user ${job.data.userId}`);
    return withAiContext({ userId: job.data.userId }, () => runInboxAgent(job.data.userId!, { tokenId: job.data.tokenId }));
  },
  { connection: createWorkerConnection(), concurrency: 1, ...workerTuning }
);

worker.on('completed', job => console.log(`[GmailWorker] Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`[GmailWorker] Job ${job?.id} failed:`, err.message));
guardWorker('GmailWorker', worker);

export default worker;
