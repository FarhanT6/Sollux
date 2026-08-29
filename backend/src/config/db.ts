import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Scripts in backend/scripts import this module (indirectly, through the
// services they reuse), and per-query logging buries their own output — a
// bulk import prints three SELECTs per file around each line that matters.
// Only the dev server wants that firehose.
const isScript = /[\\/]scripts[\\/]/.test(process.argv[1] ?? '');

export const db = global.__prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' && !isScript ? ['query', 'error', 'warn'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = db;
}
