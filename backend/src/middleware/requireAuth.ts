import { Request, Response, NextFunction } from 'express';
import { clerkClient, clerkMiddleware, getAuth, requireAuth as clerkRequireAuth } from '@clerk/express';
import { db } from '../config/db';

// Extend Express Request to include userId
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      // The account whose data this request operates on. For a shared-access
      // member this is the OWNER's id, so every route scopes to the shared
      // account without needing to know about sharing.
      dbUserId?: string;
      // The signed-in person's own user id (differs from dbUserId for members).
      actingUserId?: string;
      // True when the signed-in person owns the account (not a member).
      isAccountOwner?: boolean;
    }
  }
}

// Clerk auth middleware
export { clerkMiddleware };
export const requireAuth = clerkRequireAuth();

// Normalize a phone to digits so "(760) 672-7717", "7606727717" and
// "+17606727717" all match the same invite.
function normalizePhone(p?: string | null): string | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits || null;
}

// If this user has a pending shared-access invite (by email or phone), link
// them to the owner's account. Guards against self-invite and nesting.
async function linkPendingInvite(user: { id: string; email: string; phone: string | null }) {
  const phone = normalizePhone(user.phone);
  const candidates = await db.accountInvite.findMany({
    where: { acceptedAt: null },
  });
  const match = candidates.find(inv =>
    (inv.email && inv.email.toLowerCase() === user.email.toLowerCase()) ||
    (phone && normalizePhone(inv.phone) === phone)
  );
  if (!match || match.ownerUserId === user.id) return null;

  // Never link to an owner who is themselves a member (no nesting).
  const owner = await db.user.findUnique({ where: { id: match.ownerUserId } });
  if (!owner || owner.ownerUserId) return null;

  const updated = await db.user.update({
    where: { id: user.id },
    data: { ownerUserId: match.ownerUserId },
  });
  await db.accountInvite.update({
    where: { id: match.id },
    data: { acceptedAt: new Date(), acceptedByUserId: user.id },
  });
  console.log(`[SharedAccess] Linked ${user.email} to owner ${match.ownerUserId}`);
  return updated;
}

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
      const primaryPhone = clerkUser.phoneNumbers.find(p => p.id === clerkUser.primaryPhoneNumberId)?.phoneNumber
        ?? clerkUser.phoneNumbers[0]?.phoneNumber
        ?? null;

      // Clerk user ids are per-instance. Moving from a development instance to
      // a production one issues an entirely new id for the same person, so this
      // lookup misses and the create below collides with the `email @unique`
      // constraint — throwing on every request and locking the account's owner
      // out of their own data.
      //
      // So: adopt an existing row that carries this email and has no Clerk id
      // bound to it yet, rather than creating a second one. Only a *verified*
      // email is accepted, because an unverified one is just a string the
      // person signing up typed, and honouring it would hand an existing
      // account to anyone who claimed its address.
      const emailIsVerified = clerkUser.emailAddresses.some(
        e => e.emailAddress === primaryEmail && e.verification?.status === 'verified'
      );

      if (emailIsVerified) {
        const orphaned = await db.user.findUnique({ where: { email: primaryEmail } });
        if (orphaned && orphaned.clerkUserId === null) {
          user = await db.user.update({
            where: { id: orphaned.id },
            data: { clerkUserId, fullName: orphaned.fullName || fullName, phone: orphaned.phone ?? primaryPhone },
          });
          console.log(`[Auth] Adopted existing account for ${primaryEmail} under new Clerk id ${clerkUserId}`);
        }
      }

      if (!user) {
        user = await db.user.create({
          data: {
            clerkUserId,
            email: primaryEmail,
            fullName,
            phone: primaryPhone,
          },
        });
      }
    }

    // Shared access: if this person was invited to someone's account and
    // hasn't been linked yet, link them now (matched by email or phone).
    if (!user.ownerUserId) {
      const linked = await linkPendingInvite(user);
      if (linked) user = linked;
    }

    req.actingUserId = user.id;
    req.isAccountOwner = !user.ownerUserId;
    // Members operate on the owner's data.
    req.dbUserId = user.ownerUserId ?? user.id;
    next();
  } catch (err) {
    next(err);
  }
}
