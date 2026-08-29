import type { Worker } from 'bullmq';

/**
 * Stops the workers from hammering Redis when Redis is refusing them.
 *
 * BullMQ retries a failed poll immediately. When the Redis provider rejects
 * every command — quota exhausted, credentials revoked — that retry fails the
 * same way, so the workers spin as fast as the network allows: roughly a
 * hundred requests a second, each one billed. The condition that broke them
 * gets worse the longer they run, and the logs fill with thousands of copies
 * of one message.
 *
 * On an error that won't clear by retrying, every worker pauses. A pause stops
 * the polling loop, so the request rate goes to zero. They resume after a
 * cooldown that doubles up to an hour, in case the cause was temporary (a
 * quota that resets, a provider incident).
 */

const FATAL = /max requests limit|max daily request|quota|WRONGPASS|NOAUTH|invalid password|ERR unknown command/i;

const registered: { name: string; worker: Worker }[] = [];

const MIN_COOLDOWN = 5 * 60_000;
const MAX_COOLDOWN = 60 * 60_000;
let cooldown = MIN_COOLDOWN;
let paused = false;

/** Log at most one line per worker per minute — the failure repeats fast. */
const lastLogged = new Map<string, number>();
function logThrottled(name: string, message: string) {
  const now = Date.now();
  if (now - (lastLogged.get(name) ?? 0) < 60_000) return;
  lastLogged.set(name, now);
  console.error(`[${name}] Worker error: ${message}`);
}

async function pauseAll(reason: string) {
  if (paused) return;
  paused = true;
  console.error('─────────────────────────────────────────────');
  console.error(`Pausing all workers: ${reason}`);
  console.error('Redis is rejecting every command, and retrying costs a request each time.');
  console.error(`Retrying in ${Math.round(cooldown / 60_000)} minute(s).`);
  console.error('─────────────────────────────────────────────');

  // force: false lets a job that is already running finish.
  await Promise.all(registered.map(r => r.worker.pause().catch(() => {})));

  setTimeout(async () => {
    console.log('[RedisGuard] Cooldown over — resuming workers.');
    paused = false;
    cooldown = Math.min(cooldown * 2, MAX_COOLDOWN);
    await Promise.all(registered.map(r => r.worker.resume()));
  }, cooldown).unref();
}

/**
 * Attach error handling to a worker. Replaces a bare worker.on('error') —
 * ordinary errors are logged (throttled), fatal ones stop the fleet.
 */
export function guardWorker(name: string, worker: Worker<any, any, any>): void {
  registered.push({ name, worker: worker as Worker });
  worker.on('error', (err: Error) => {
    logThrottled(name, err.message);
    if (FATAL.test(err.message)) void pauseAll(err.message);
  });
}

/** Reset the backoff once something succeeds, so one bad hour isn't permanent. */
export function noteHealthy(): void {
  cooldown = MIN_COOLDOWN;
}
