import { Worker, Job } from 'bullmq';
import { generateInsightsForProperty } from '../ai/insightEngine';
import { runBookkeeperForEveryone } from '../ai/bookkeeper';
import { guardWorker } from './redisGuard';
import { withAiContext } from '../ai/meter';
import { db } from '../config/db';
import { createWorkerConnection, workerTuning } from './queues';

const worker = new Worker(
  'insights',
  async (job: Job) => {
    if (job.name === 'bookkeeper') {
      console.log('[InsightWorker] Running the bookkeeper');
      await runBookkeeperForEveryone();
      return;
    }
    const { propertyId } = job.data;
    console.log(`[InsightWorker] Generating insights for property ${propertyId}`);
    // Its Claude calls count against the property owner's AI allowance.
    const owner = await db.property.findUnique({ where: { id: propertyId }, select: { userId: true } });
    await withAiContext({ userId: owner?.userId ?? null }, () => generateInsightsForProperty(propertyId));
    console.log(`[InsightWorker] Done for property ${propertyId}`);
  },
  { connection: createWorkerConnection(), concurrency: 5, ...workerTuning }
);

worker.on('failed', (job, err) => {
  console.error(`[InsightWorker] Job ${job?.id} failed:`, err.message);
});

guardWorker('InsightWorker', worker);

export default worker;
