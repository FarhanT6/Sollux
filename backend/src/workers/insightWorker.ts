import { Worker, Job } from 'bullmq';
import { generateInsightsForProperty } from '../ai/insightEngine';
import { redisConnection } from './queues';

const worker = new Worker(
  'insights',
  async (job: Job) => {
    const { propertyId } = job.data;
    console.log(`[InsightWorker] Generating insights for property ${propertyId}`);
    await generateInsightsForProperty(propertyId);
    console.log(`[InsightWorker] Done for property ${propertyId}`);
  },
  { connection: redisConnection, concurrency: 5 }
);

worker.on('failed', (job, err) => {
  console.error(`[InsightWorker] Job ${job?.id} failed:`, err.message);
});

export default worker;
