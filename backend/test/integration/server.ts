/**
 * A throwaway API for integration tests: TEST_DATABASE_URL (a database these
 * tests may wipe — never production) with the schema pushed, the API started
 * on a free port with the local sign-in stub (every request is the owner
 * "user_mock", owner@example.com). Without TEST_DATABASE_URL the tests skip.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

export const TEST_DB = process.env.TEST_DATABASE_URL;
export const skip = !TEST_DB ? 'set TEST_DATABASE_URL (a disposable Postgres database) and REDIS_URL to run' : false;
const backend = path.resolve(__dirname, '../..');

const freePort = () => new Promise<number>(resolve => {
  const s = createServer(); s.listen(0, () => { const p = (s.address() as any).port; s.close(() => resolve(p)); });
});

export interface TestApi { url: string; db: PrismaClient; stop: () => Promise<void> }

export async function startApi(env: Record<string, string> = {}): Promise<TestApi> {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL is not set');
  if (/neon\.tech|render\.com|amazonaws\.com/.test(TEST_DB)) throw new Error('TEST_DATABASE_URL looks like a hosted database; use a local disposable one');
  execSync('npx prisma db push --skip-generate --force-reset --accept-data-loss', { cwd: backend, env: { ...process.env, DATABASE_URL: TEST_DB, DIRECT_DATABASE_URL: TEST_DB }, stdio: 'ignore' });
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['-r', './scripts/dev/devAuth.cjs', '--import', 'tsx', 'src/index.ts'], {
    cwd: backend,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: TEST_DB, DIRECT_DATABASE_URL: TEST_DB,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? '0'.repeat(64), REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      RUN_WORKERS_IN_API: 'false', ...env,
    },
    stdio: 'ignore',
  });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${url}/api/health`).then(() => true).catch(() => false)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const db = new PrismaClient({ datasources: { db: { url: TEST_DB } } });
  return { url, db, stop: async () => { child.kill('SIGKILL'); await db.$disconnect(); } };
}

/** The signed-in owner (the sign-in stub's user), on a trial unless told otherwise. */
export const OWNER = { clerkUserId: 'user_mock', email: 'owner@example.com', fullName: 'Alex Morgan' };
