/**
 * Settings → Account → Speed check: where the time goes when the app is slow
 * to open, measured on the owner's own setup rather than guessed at.
 * - the server: when it last started (a server that was asleep starts on the
 *   first visit, and that visit waits for it);
 * - the database: how long one trip to it takes (a few milliseconds when it
 *   is in the same region as the server; tens when it is across the country),
 *   and how long the first one took (a database that pauses when idle wakes
 *   on it);
 * - this request's sign-in check, and the Overview's summary on this account.
 * The browser adds its own trip to the server (components/settings/SpeedCheck).
 */
import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
const STARTED_AT = Date.now();

/** Where the database is, from its address: its region part only, never the address or its password. */
export function databasePlace(url: string | undefined): { region: string | null; pooled: boolean; provider: string | null } {
  try {
    const host = new URL(url ?? '').hostname;
    const neon = /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(host);
    if (neon) return { region: `AWS ${neon[1]}`, pooled: host.includes('-pooler'), provider: 'Neon' };
    const render = /\.([a-z]+)-postgres\.render\.com$/.exec(host);
    if (render) return { region: render[1], pooled: false, provider: 'Render Postgres' };
    const aws = /\.([a-z]{2}-[a-z]+-\d)\.rds\.amazonaws\.com$/.exec(host);
    if (aws) return { region: `AWS ${aws[1]}`, pooled: false, provider: 'Amazon RDS' };
    const supabase = /\.([a-z]{2}-[a-z]+-\d)\.pooler\.supabase\.com$/.exec(host);
    if (supabase) return { region: `AWS ${supabase[1]}`, pooled: true, provider: 'Supabase' };
    return { region: null, pooled: /pooler|pgbouncer/.test(url ?? ''), provider: /localhost|127\.0\.0\.1/.test(host) ? 'local' : null };
  } catch { return { region: null, pooled: false, provider: null }; }
}

router.get('/', attachDbUser, async (req, res, next) => {
  try {
    const arrived = (req as unknown as { receivedAt?: number }).receivedAt ?? performance.now();
    const signInMs = Math.round(performance.now() - arrived);
    const trips: number[] = [];
    for (let i = 0; i < 5; i++) { const t = performance.now(); await db.$queryRaw`SELECT 1`; trips.push(performance.now() - t); }
    const sorted = [...trips].sort((a, b) => a - b);
    const t = performance.now();
    await fetchSummary(req.dbUserId!);
    const summaryMs = Math.round(performance.now() - t);
    res.json({
      server: { startedAt: new Date(STARTED_AT).toISOString(), upSeconds: Math.round((Date.now() - STARTED_AT) / 1000), commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null },
      database: {
        // The first of the five: a database that paused while idle wakes on it.
        tripMs: Math.round(sorted[2] * 10) / 10, bestMs: Math.round(sorted[0] * 10) / 10, firstTripMs: Math.round(trips[0]),
        // Its region is shown to the person who runs Sollux only.
        ...(req.isPlatformAdmin ? databasePlace(process.env.DATABASE_URL) : {}),
      },
      signInMs, summaryMs, serverMs: Math.round(performance.now() - arrived),
    });
  } catch (err) { next(err); }
});

/** The Overview summary's queries, timed (routes/dashboard.ts). */
async function fetchSummary(userId: string) {
  await Promise.all([
    db.property.count({ where: { userId } }),
    db.utilityAccount.count({ where: { property: { userId } } }),
    db.aIInsight.count({ where: { property: { userId }, isRead: false, isDismissed: false } }),
  ]);
}

export default router;
