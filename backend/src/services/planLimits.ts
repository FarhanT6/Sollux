import { db } from '../config/db';
import { propertyLimit } from '../lib/plans';

/** Why the account cannot add another property under its plan, or null when it can. */
export async function propertyLimitReached(userId: string): Promise<string | null> {
  const owner = await db.user.findUnique({ where: { id: userId } });
  if (!owner) return null;
  const limit = propertyLimit(owner);
  if (limit == null) return null;
  const count = await db.property.count({ where: { userId } });
  return count >= limit ? `Your plan includes up to ${limit} propert${limit === 1 ? 'y' : 'ies'}. Upgrade to add more.` : null;
}
