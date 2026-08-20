import { db } from '../config/db';
import { encryptOptional } from '../crypto/encrypt';

/**
 * Find or create the utility account a bill belongs to.
 *
 * This exists because "check whether an account exists, then create one" is a
 * race whenever bills are processed concurrently. A folder of thirty SDG&E
 * bills for a property with no SDG&E account would have every one of them see
 * "no account", and every one of them create its own — thirty accounts holding
 * one bill each instead of one account holding thirty.
 *
 * Two guards:
 *  - an in-process lock per (property, provider, category) so concurrent
 *    callers in the same batch queue behind the first, and
 *  - a fresh lookup inside the lock, so the second caller finds what the first
 *    just made instead of creating a duplicate.
 *
 * The lock is per process, so it does not protect against two Render instances
 * importing the same property at once. The re-check inside narrows that window
 * to milliseconds; a database-level unique constraint would close it entirely,
 * but existing duplicates have to be merged before one can be added.
 */

const locks = new Map<string, Promise<unknown>>();

/** Run fn with exclusive access to `key`, queueing concurrent callers. */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  // Swallow the predecessor's rejection: one caller failing must not cascade.
  const run = prior.catch(() => {}).then(fn);
  locks.set(key, run.catch(() => {}));
  try {
    return await run;
  } finally {
    // Only clear if nobody else queued behind us.
    if (locks.get(key) === run || locks.get(key) === run.catch(() => {})) locks.delete(key);
  }
}

export function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// Provider names vary between bills of the same provider ("SDGE", "SDG&E",
// "San Diego Gas & Electric"). Comparing the letters alone catches most of it.
function providerKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function providersLookAlike(a: string, b: string): boolean {
  const x = providerKey(a);
  const y = providerKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

export interface ResolveAccountInput {
  propertyId: string;
  providerName: string | null;
  category: string;
  accountNumber?: string | null;
}

export interface ResolvedAccount {
  id: string;
  created: boolean;
}

export async function findOrCreateUtilityAccount(
  input: ResolveAccountInput,
): Promise<ResolvedAccount> {
  const providerName = input.providerName?.trim() || 'Unknown provider';
  const slug = toSlug(providerName);
  const key = `${input.propertyId}|${slug}|${input.category}`;

  return withLock(key, async () => {
    const existing = await db.utilityAccount.findMany({
      where: { propertyId: input.propertyId },
      select: { id: true, providerName: true, providerSlug: true, category: true, accountNumberEnc: true },
    });

    // Exact slug beats a fuzzy name match; a name that merely looks alike is
    // only accepted within the same category, so a provider that bills for both
    // water and trash doesn't collapse into one account.
    const match =
      existing.find(a => a.providerSlug === slug) ??
      existing.find(a => a.category === input.category && providersLookAlike(a.providerName, providerName));

    if (match) {
      // Backfill the encrypted account number if this bill carries one and the
      // account was created without it — matchToAccount skips accounts with no
      // accountNumberEnc, so an account missing it can never match by number.
      if (input.accountNumber && !match.accountNumberEnc) {
        await db.utilityAccount.update({
          where: { id: match.id },
          data: {
            accountNumberEnc: encryptOptional(input.accountNumber),
            accountNumber: input.accountNumber.slice(-4),
          },
        });
      }
      return { id: match.id, created: false };
    }

    const created = await db.utilityAccount.create({
      data: {
        propertyId: input.propertyId,
        providerName,
        providerSlug: slug,
        category: input.category as any,
        accountNumber: input.accountNumber ? input.accountNumber.slice(-4) : null,
        // Store it encrypted too, so the strongest matching signal works for
        // accounts the importer creates and not just hand-entered ones.
        accountNumberEnc: encryptOptional(input.accountNumber ?? null),
      },
    });
    return { id: created.id, created: true };
  });
}
