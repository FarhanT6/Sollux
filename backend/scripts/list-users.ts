// Diagnostic: list every user in whatever DATABASE_URL is currently pointed at.
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const users = await db.user.findMany({ select: { id: true, email: true, clerkUserId: true, createdAt: true } });
  console.log(`${users.length} user(s) in this database:`);
  for (const u of users) console.log(`- ${u.email} (clerkUserId=${u.clerkUserId ?? 'none'}, created ${u.createdAt.toISOString()})`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
