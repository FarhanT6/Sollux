// One-off cleanup: deletes every CREDIT_CARD utility account (and its
// cascaded statements) on a given property. Use this to recover from a
// botched import before re-running with clean data.
//
// Usage:
//   npx tsx scripts/purge-credit-cards.ts --email you@example.com --property "<address or nickname>" [--dry-run]

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const email = getArg('email');
  const propertyQuery = getArg('property');
  const dryRun = args.includes('--dry-run');

  if (!email || !propertyQuery) {
    console.error('Usage: npx tsx scripts/purge-credit-cards.ts --email <you@example.com> --property "<address or nickname>" [--dry-run]');
    process.exit(1);
  }

  const user = await db.user.findUnique({ where: { email } });
  if (!user) { console.error(`No user found with email ${email}`); process.exit(1); }

  const properties = await db.property.findMany({ where: { userId: user.id } });
  const property = properties.find(p =>
    p.address.toLowerCase().includes(propertyQuery.toLowerCase()) ||
    (p.nickname || '').toLowerCase().includes(propertyQuery.toLowerCase())
  );
  if (!property) {
    console.error(`No property matching "${propertyQuery}" found.`);
    process.exit(1);
  }

  const accounts = await db.utilityAccount.findMany({
    where: { propertyId: property.id, category: 'CREDIT_CARD' as any },
    include: { _count: { select: { statements: true } } },
  });

  console.log(`Property: ${property.nickname || property.address}`);
  console.log(`Found ${accounts.length} CREDIT_CARD accounts:`);
  for (const a of accounts) {
    console.log(`  ${a.providerName} — ${a._count.statements} statements${dryRun ? '' : ' (deleting)'}`);
  }

  if (dryRun) {
    console.log('\nDry run — nothing deleted. Re-run without --dry-run to delete.');
    return;
  }

  const result = await db.utilityAccount.deleteMany({
    where: { propertyId: property.id, category: 'CREDIT_CARD' as any },
  });
  console.log(`\nDeleted ${result.count} accounts (and their statements via cascade).`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
