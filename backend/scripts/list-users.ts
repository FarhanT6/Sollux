// Diagnostic: list every user in whatever DATABASE_URL is currently pointed at,
// along with a quick sanity-check count of their data.
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const users = await db.user.findMany({ select: { id: true, email: true, clerkUserId: true, createdAt: true } });
  console.log(`${users.length} user(s) in this database:`);
  for (const u of users) {
    const [properties, loans, bills, utilityAccounts] = await Promise.all([
      db.property.count({ where: { userId: u.id } }),
      db.loan.count({ where: { userId: u.id } }),
      db.rentPayment.count({ where: { lease: { unit: { property: { userId: u.id } } } } }),
      db.utilityAccount.count({ where: { property: { userId: u.id } } }),
    ]);
    console.log(
      `- email="${u.email}" clerkUserId=${u.clerkUserId ?? 'none'} created=${u.createdAt.toISOString()} ` +
      `| properties=${properties} loans=${loans} rentPayments=${bills} utilityAccounts=${utilityAccounts}`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
