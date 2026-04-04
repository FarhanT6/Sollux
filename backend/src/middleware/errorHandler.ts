import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  console.error(`[${new Date().toISOString()}] Error:`, err.message);

  if (process.env.NODE_ENV === 'development') {
    console.error(err.stack);
  }

  if (err.name === 'ZodError') {
    return res.status(400).json({ error: 'Validation error', details: JSON.parse(err.message) });
  }

  if (err.name === 'PrismaClientKnownRequestError') {
    return res.status(400).json({ error: 'Database error', code: (err as any).code });
  }

  return res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
  });
}
