/**
 * The workers' heartbeat: once a minute the process that runs the BullMQ
 * workers writes that it is alive (Postgres, not Redis — it must not spend
 * the metered Redis quota, and it must still work when Redis is the problem).
 *
 * Without it a queued job that never ran looked the same whether the worker
 * service was missing, crashed, paused by the Redis guard, or just busy.
 * workerStatus() tells those apart for the app and the auditor.
 */
import { db } from '../config/db';
import { isPaused } from './redisGuard';

let active = 0;
/** Count a job in and out, for "busy with N jobs". */
export const jobStarted = () => { active++; };
export const jobEnded = () => { active = Math.max(0, active - 1); };

export function startHeartbeat(name: string): void {
  const startedAt = new Date();
  const beat = () => db.workerHeartbeat.upsert({
    where: { name },
    create: { name, startedAt, seenAt: new Date(), paused: isPaused(), active, commit: process.env.RENDER_GIT_COMMIT ?? null },
    update: { startedAt, seenAt: new Date(), paused: isPaused(), active, commit: process.env.RENDER_GIT_COMMIT ?? null },
  }).catch(err => console.warn('[Heartbeat] not written:', err instanceof Error ? err.message : err));
  void beat();
  setInterval(beat, 60_000).unref();
}

export type WorkerState = 'ok' | 'busy' | 'paused' | 'stopped' | 'never';
export interface WorkerStatus { state: WorkerState; name: string | null; lastSeen: Date | null; active: number; message: string }

/** Whether anything is processing queued jobs, and if not, why. */
export async function workerStatus(): Promise<WorkerStatus> {
  const beats = await db.workerHeartbeat.findMany({ orderBy: { seenAt: 'desc' } });
  const live = beats.find(b => Date.now() - b.seenAt.getTime() < 3 * 60_000);
  if (!live) {
    const last = beats[0];
    if (!last) return { state: 'never', name: null, lastSeen: null, active: 0, message: 'No background worker has ever reported in. On Render, the sollux-workers service is missing or has never started — create it (Background Worker, root backend, start command node dist/workers/index.js, env group sollux-env), or set RUN_WORKERS_IN_API=true on sollux-api to run the workers inside the API.' };
    return { state: 'stopped', name: last.name, lastSeen: last.seenAt, active: 0, message: `The background worker (${last.name}) stopped reporting ${Math.round((Date.now() - last.seenAt.getTime()) / 60_000)} minutes ago — it has crashed or been suspended. Check its logs on Render and restart it.` };
  }
  if (live.paused) return { state: 'paused', name: live.name, lastSeen: live.seenAt, active: live.active, message: 'The background worker is paused because Redis refused requests (usually the Upstash request quota). It resumes on its own; if this lasts, check the Redis plan.' };
  if (live.active > 0) return { state: 'busy', name: live.name, lastSeen: live.seenAt, active: live.active, message: `The background worker is busy with ${live.active} other job${live.active === 1 ? '' : 's'}; this one starts when a slot frees up.` };
  return { state: 'ok', name: live.name, lastSeen: live.seenAt, active: 0, message: 'The background worker is running.' };
}
