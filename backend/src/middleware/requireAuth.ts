import { Request, Response, NextFunction } from 'express';
import { clerkClient, clerkMiddleware, getAuth, requireAuth as clerkRequireAuth } from '@clerk/express';
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
export { clerkMiddleware };
export const requireAuth = clerkRequireAuth();

// Middleware to attach the database User record to the request
export async function attachDbUser(req: Request, res: Response, next: NextFunction) {
  try {
    const clerkUserId = getAuth(req)?.userId;
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let user = await db.user.findUnique({ where: { clerkUserId } });

    // Auto-create user record on first request (after Clerk registration).
    // sessionClaims does NOT include email/name by default — Clerk only puts
    // those in the JWT if you've explicitly added them as custom claims in
    // the dashboard. Without that, clerkUser.sessionClaims?.email was always
    // undefined, so every new signup fell back to the same empty string —
    // which collided with the `email @unique` constraint the instant a
    // second account tried to sign up, throwing a Prisma unique-constraint
    // error on every single request from that second account. Fetch the
    // real email from Clerk's API instead of trusting the session claims.
    if (!user) {
      const clerkUser = await clerkClient.users.getUser(clerkUserId);
      const primaryEmail = clerkUser.emailAddresses.find(e => e.id === clerkUser.primaryEmailAddressId)?.emailAddress
        ?? clerkUser.emailAddresses[0]?.emailAddress
        ?? `${clerkUserId}@no-email.sollux.local`;
      const fullName = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || 'User';
      user = await db.user.create({
        data: {
          clerkUserId,
          email: primaryEmail,
          fullName,
        },
      });
    }

    req.dbUserId = user.id;
    next();
  } catch (err) {
    next(err);
  }
}
