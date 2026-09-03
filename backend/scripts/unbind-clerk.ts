/**
 * Detaches an account from its current Clerk user id, so the next sign-in
 * re-binds it.
 *
 * Clerk user ids are per-instance. Moving from a development instance to a
 * production one issues a new id for the same person, and the account would
 * otherwise be unreachable: the lookup by id misses, and creating a fresh row
 * collides with the `email @unique` constraint.
 *
 * Run this immediately before swapping the keys. The first sign-in on the new
 * instance then adopts the existing row — with every property, statement and
 * payment intact — provided the email is verified there.
 *
 * Usage, from backend/:
 *   npx tsx scripts/unbind-clerk.ts you@example.com          # show what would change
 *   npx tsx scripts/unbind-clerk.ts you@example.com --apply  # do it
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const EMAIL = process.argv[2];
const APPLY = process.argv.includes('--apply');

(async () => {
  if (!EMAIL || EMAIL.startsWith('--')) {
    console.error('Pass the account email. Example:\n  npx tsx scripts/unbind-clerk.ts you@example.com');
    process.exit(1);
  }

  const user = await db.user.findUnique({
    where: { email: EMAIL },
    select: { id: true, email: true, fullName: true, clerkUserId: true, ownerUserId: true },
  });

  if (!user) {
    console.log(`No account with email ${EMAIL}. Accounts on file:\n`);
    const all = await db.user.findMany({ select: { email: true, clerkUserId: true }, orderBy: { email: 'asc' } });
    for (const u of all) console.log(`  ${u.email}${u.clerkUserId ? '' : '  (already unbound)'}`);
    await db.$disconnect();
    return;
  }

  // Say what is at stake before touching anything: the point of the exercise is
  // that this data stays reachable, so it is worth seeing it counted.
  const [properties, statements] = await Promise.all([
    db.property.count({ where: { userId: user.id } }),
    db.statement.count({ where: { utilityAccount: { property: { userId: user.id } } } }),
  ]);

  console.log(`\n${user.fullName || user.email}`);
  console.log(`  id            ${user.id}`);
  console.log(`  clerkUserId   ${user.clerkUserId ?? '(none — already unbound)'}`);
  console.log(`  ${properties} propert${properties === 1 ? 'y' : 'ies'}, ${statements} statement(s) attached`);
  if (user.ownerUserId) console.log(`  member of shared account ${user.ownerUserId}`);

  if (user.clerkUserId === null) {
    console.log('\nAlready unbound. The next verified sign-in with this email will claim it.');
    await db.$disconnect();
    return;
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to unbind, then swap the Clerk keys and sign in.');
    await db.$disconnect();
    return;
  }

  await db.user.update({ where: { id: user.id }, data: { clerkUserId: null } });
  console.log('\nUnbound. Swap the Clerk keys now and sign in with this email — the account re-binds on first request.');
  console.log('Until then nobody can sign into it, so do not leave it in this state.');

  await db.$disconnect();
})().catch(async e => {
  console.error('Failed:', e.message);
  await db.$disconnect();
  process.exit(1);
});
