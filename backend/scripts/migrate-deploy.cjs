/**
 * `prisma migrate deploy`, made safe for how Sollux is hosted.
 *
 * Two Render services (the API and the workers) build from the same repo at
 * the same time, and each build runs the migrations. Prisma serialises
 * migrators with a Postgres advisory lock and gives up after ten seconds;
 * the second builder routinely waited on the first and failed the deploy
 * with P1002 while nothing was actually wrong. Neon's connection pooler
 * makes it worse — session-level advisory locks do not survive a
 * transaction-mode pooler — so migrations go to the direct host when one is
 * given (DIRECT_DATABASE_URL), and the whole step is retried.
 */
const { spawnSync } = require('node:child_process');

const direct = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
const env = { ...process.env, DIRECT_DATABASE_URL: direct };
if (!env.DIRECT_DATABASE_URL) {
  console.error('[migrate] DATABASE_URL is not set');
  process.exit(1);
}

const attempts = Number(process.env.MIGRATE_ATTEMPTS || 6);
const waitMs = Number(process.env.MIGRATE_RETRY_MS || 15000);

for (let i = 1; i <= attempts; i++) {
  const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status === 0) process.exit(0);
  if (i === attempts) {
    console.error(`[migrate] gave up after ${attempts} attempts`);
    process.exit(r.status ?? 1);
  }
  console.warn(`[migrate] attempt ${i} failed (exit ${r.status}); another build is probably migrating — retrying in ${waitMs / 1000}s`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
}
