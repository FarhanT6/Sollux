import { Request, Response, NextFunction } from 'express';

/**
 * Prisma error codes worth reporting as something other than a generic 500.
 * https://www.prisma.io/docs/reference/api-reference/error-reference
 */
const PRISMA_STATUS: Record<string, { status: number; error: string }> = {
  P2025: { status: 404, error: 'Not found' },
  P2002: { status: 409, error: 'Already exists' },
  P2003: { status: 400, error: 'Referenced record does not exist' },
  P2024: { status: 503, error: 'Database connection pool timed out — try again' },
  P1001: { status: 503, error: 'Cannot reach the database' },
  P1002: { status: 503, error: 'Database connection timed out' },
  // A column or table the schema expects is missing: a migration that never
  // reached this database. Not the caller's fault, and not a validation error.
  P2021: { status: 500, error: 'Database schema is out of date (migration not applied)' },
  P2022: { status: 500, error: 'Database schema is out of date (migration not applied)' },
};

/** Redis is unavailable or refusing commands — the request can be retried. */
function isRedisOutage(message: string): boolean {
  return /max requests limit|ECONNREFUSED.*6379|Connection is closed|Stream isn't writeable|NOAUTH|WRONGPASS|Redis/i.test(message);
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  // The route matters as much as the message when reading production logs.
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} — ${err.message}`);
  if (process.env.NODE_ENV === 'development') console.error(err.stack);

  if (err.name === 'ZodError') {
    return res.status(400).json({ error: 'Validation error', details: JSON.parse(err.message) });
  }

  if (err.name === 'PrismaClientKnownRequestError') {
    const code = (err as any).code as string | undefined;
    const mapped = code ? PRISMA_STATUS[code] : undefined;
    if (mapped) return res.status(mapped.status).json({ error: mapped.error, code });
    return res.status(400).json({ error: 'Database error', code });
  }

  if (isRedisOutage(err.message)) {
    return res.status(503).json({
      error: 'Background job queue is unavailable — the change may have saved, but syncing is paused.',
    });
  }

  // Routes can set err.status for a deliberate, already-worded failure.
  const status = (err as any).status;
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return res.status(status).json({ error: err.message });
  }

  return res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
  });
}
