// One-off fix for accounts created before requireAuth.ts correctly fetched
// email from Clerk — those rows got stuck with email = '' (see the bug
// fixed in requireAuth.ts: sessionClaims.email was never actually
// populated, so every auto-created user silently got an empty string).
//
// Usage:
//   cd backend
//   DATABASE_URL=<neon url> CLERK_SECRET_KEY=<sk_...> npx tsx scripts/backfill-user-emails.ts

import { PrismaClient } from '@prisma/client';
import { clerkClient } from '@clerk/express';

const db = new PrismaClient();

async function main() {
  const broken = await db.user.findMany({ where: { email: '' } });
  console.log(`${broken.length} user(s) with a blank email.`);

  for (const u of broken) {
    if (!u.clerkUserId) {
      console.log(`- ${u.id}: no clerkUserId on file, skipping.`);
      continue;
    }
    const clerkUser = await clerkClient.users.getUser(u.clerkUserId);
    const primaryEmail = clerkUser.emailAddresses.find(e => e.id === clerkUser.primaryEmailAddressId)?.emailAddress
      ?? clerkUser.emailAddresses[0]?.emailAddress
      ?? null;
    if (!primaryEmail) {
      console.log(`- ${u.id} (clerkUserId=${u.clerkUserId}): Clerk has no email on file either, skipping.`);
      continue;
    }
    await db.user.update({ where: { id: u.id }, data: { email: primaryEmail } });
    console.log(`- ${u.id} (clerkUserId=${u.clerkUserId}): backfilled email -> ${primaryEmail}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
