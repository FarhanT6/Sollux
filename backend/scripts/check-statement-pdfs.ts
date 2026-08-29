// Diagnostic: for each utility account, show how many statements exist,
// how many have a PDF attached, and where each statement came from
// (scraper vs. manual import vs. email) — to figure out whether a
// "missing PDF" is because it was never captured (scraper gap) or because
// a manual import attempt didn't actually go through.
//
// Usage:
//   cd backend
//   DATABASE_URL=<neon url> npx tsx scripts/check-statement-pdfs.ts
//   DATABASE_URL=<neon url> npx tsx scripts/check-statement-pdfs.ts "City of Oceanside"   # filter by provider name (substring, case-insensitive)

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const filter = process.argv[2]?.toLowerCase();
  const accounts = await db.utilityAccount.findMany({
    include: { statements: { orderBy: { statementDate: 'desc' } }, property: { select: { nickname: true, address: true } } },
    orderBy: { providerName: 'asc' },
  });

  const filtered = filter ? accounts.filter(a => a.providerName.toLowerCase().includes(filter)) : accounts;

  for (const a of filtered) {
    const withPdf = a.statements.filter(s => s.pdfS3Key != null).length;
    const bySource = a.statements.reduce((acc: Record<string, number>, s) => {
      acc[s.sourceType] = (acc[s.sourceType] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`\n${a.providerName} (${a.property.nickname || a.property.address}) — ${a.statements.length} statements, ${withPdf} with a PDF`);
    console.log(`  by source: ${JSON.stringify(bySource)}`);
    for (const s of a.statements.slice(0, 6)) {
      console.log(`  - ${s.statementDate.toISOString().slice(0, 10)} | source=${s.sourceType} | pdf=${s.pdfS3Key ? 'yes' : 'NO'} | amountDue=${s.amountDue}`);
    }
    if (a.statements.length > 6) console.log(`  ... and ${a.statements.length - 6} more`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
