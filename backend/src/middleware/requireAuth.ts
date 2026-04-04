import { Request, Response, NextFunction } from 'express';
import { getAuth, requireAuth as clerkRequireAuth } from '@clerk/express';
import { db } from '../config/db';

// Extend Express Request to include userId
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      dbUserId?: string;
    }
  }
}

// Clerk auth middleware
export const requireAuth = clerkRequireAuth();

// Middleware to attach the database User record to the request
export async function attachDbUser(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = getAuth(req);
    const clerkUserId = auth?.userId;
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let user = await db.user.findUnique({ where: { clerkUserId } });

    // Auto-create user record on first request (after Clerk registration)
    if (!user) {
      const clerkUser = auth as any;
      user = await db.user.create({
        data: {
          clerkUserId,
          email: clerkUser.sessionClaims?.email || '',
          fullName: clerkUser.sessionClaims?.name || 'User',
        },
      });
    }

    req.dbUserId = user.id;
    next();
  } catch (err) {
    next(err);
  }
}
