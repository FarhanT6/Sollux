import { Request, Response, NextFunction } from 'express';

// Prisma error codes worth translating into something the caller can act on.
// Everything else stays a 500 — an unrecognised database fault is a server
// problem, not a bad request.
const PRISMA_STATUS: Record<string, { status: number; error: string }> = {
  P2025: { status: 404, error: 'Not found' },
  P2001: { status: 404, error: 'Not found' },
  P2002: { status: 409, error: 'Already exists' },
  P2003: { status: 409, error: 'Referenced record is still in use' },
  P2024: { status: 503, error: 'Database is busy — connection pool timed out. Try again.' },
  P1001: { status: 503, error: 'Cannot reach the database.' },
  P1002: { status: 503, error: 'Database timed out.' },
  P2021: { status: 500, error: 'A database table is missing — a migration has not been applied.' },
  P2022: { status: 500, error: 'A database column is missing — a migration has not been applied.' },
};

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  const code = (err as any).code;
  // Log the route with it. "Error: Invalid invocation" on its own says nothing
  // about which request produced it, which makes production faults very hard
  // to place.
  console.error(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${err.name}` +
    `${code ? ` (${code})` : ''}: ${err.message}`
  );
  if (process.env.NODE_ENV === 'development') console.error(err.stack);

  if (err.name === 'ZodError') {
    return res.status(400).json({ error: 'Validation error', details: JSON.parse(err.message) });
  }

  // Routes can throw with an explicit status (see assertOwnership in legal.ts).
  const explicit = (err as any).status;
  if (typeof explicit === 'number' && explicit >= 400 && explicit < 600) {
    return res.status(explicit).json({ error: err.message });
  }

  if (err.name?.startsWith('PrismaClient')) {
    const mapped = PRISMA_STATUS[code];
    if (mapped) return res.status(mapped.status).json({ error: mapped.error, code });
    // Previously every Prisma fault became a 400 "Database error" with the
    // message dropped, so a server-side problem looked like a bad request and
    // gave the client nothing to go on. Unknown faults are 500s, and the
    // message travels — these are the owner's own errors, not a public API's.
    return res.status(500).json({
      error: 'Database error',
      code: code ?? null,
      message: err.message.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 500),
    });
  }

  return res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
  });
}
