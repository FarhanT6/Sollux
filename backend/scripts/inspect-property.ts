/**
 * Shows what a property actually holds: its utility accounts, how many
 * statements each has, the date range they cover, and how complete the
 * extracted data is.
 *
 * Answers "did the import land?" directly, rather than inferring it from what
 * a page does or does not render.
 *
 * Usage, from backend/:
 *   npx tsx scripts/inspect-property.ts "1015 S Coast"     # match by address
 *   npx tsx scripts/inspect-property.ts <propertyId>
 *   npx tsx scripts/inspect-property.ts "1015 S Coast" --statements
 *
 * Read-only.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const QUERY = process.argv[2];
const SHOW_STATEMENTS = process.argv.includes('--statements');

const money = (n: any) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

(async () => {
  if (!QUERY) {
    console.error('Pass a property id or part of its address.');
    process.exit(1);
  }

  const properties = await db.property.findMany({
    where: {
      OR: [
        { id: QUERY },
        { address: { contains: QUERY, mode: 'insensitive' } },
        { nickname: { contains: QUERY, mode: 'insensitive' } },
      ],
    },
    select: { id: true, address: true, nickname: true, city: true, state: true, userId: true },
  });

  if (properties.length === 0) {
    // List what does exist. A miss is usually a property filed under a
    // different name, not a missing one, and guessing at the query from the
    // outside costs more round trips than printing the list.
    console.log(`No property matches "${QUERY}". Properties on file:\n`);
    const all = await db.property.findMany({
      select: { id: true, address: true, nickname: true, city: true, state: true },
      orderBy: { address: 'asc' },
    });
    for (const p of all) {
      console.log(`  ${p.nickname ? `${p.nickname} — ` : ''}${p.address}, ${p.city} ${p.state}`);
    }
    console.log(`\n${all.length} propert${all.length === 1 ? 'y' : 'ies'}.`);
    await db.$disconnect();
    return;
  }

  for (const p of properties) {
    console.log(`\n${p.nickname || p.address} — ${p.city}, ${p.state}`);
    console.log(`  id: ${p.id}`);
    console.log(`  owner userId: ${p.userId}`);

    const accounts = await db.utilityAccount.findMany({
      where: { propertyId: p.id },
      select: {
        id: true, providerName: true, providerSlug: true, category: true,
        isActive: true, createdAt: true, accountNumberEnc: true,
        _count: { select: { statements: true, payments: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (accounts.length === 0) {
      console.log('  No utility accounts.');
      continue;
    }

    let total = 0;
    for (const a of accounts) {
      total += a._count.statements;
      const range = await db.statement.aggregate({
        where: { utilityAccountId: a.id },
        _min: { statementDate: true },
        _max: { statementDate: true },
      });
      // How many carry a usable amount — a statement row that extracted nothing
      // is present but not useful, and that distinction matters after an import.
      const withAmount = await db.statement.count({
        where: { utilityAccountId: a.id, amountDue: { not: null } },
      });

      console.log(
        `\n  ${a.providerName}  [${a.category}]${a.isActive ? '' : ' (inactive)'}\n` +
        `    id ${a.id}  slug ${a.providerSlug}${a.accountNumberEnc ? '  acct# stored' : '  no acct#'}\n` +
        `    ${a._count.statements} statement(s), ${withAmount} with an amount, ${a._count.payments} payment(s)\n` +
        `    covering ${day(range._min.statementDate)} → ${day(range._max.statementDate)}`
      );

      if (SHOW_STATEMENTS && a._count.statements > 0) {
        const statements = await db.statement.findMany({
          where: { utilityAccountId: a.id },
          orderBy: { statementDate: 'desc' },
          select: {
            statementDate: true, dueDate: true, amountDue: true, balance: true,
            pastDueCarried: true, penaltiesFees: true, amountPaid: true,
            billingPeriodStart: true, billingPeriodEnd: true,
            pdfS3Key: true, sourceType: true,
          },
        });
        // Every statement, not a window: the point of this listing is usually
        // to find which bills are absent, and a truncated list cannot answer
        // that. The billing period is shown because it, not the issue date, is
        // what identifies a bill — a drifting cycle puts two in one month.
        for (const s of statements) {
          const period = s.billingPeriodStart || s.billingPeriodEnd
            ? `${day(s.billingPeriodStart)}→${day(s.billingPeriodEnd)}`
            : 'no period';
          console.log(
            `      issued ${day(s.statementDate)}  covers ${period}  ` +
            `amt ${money(s.amountDue)}  bal ${money(s.balance)}  ` +
            `pastDue ${money(s.pastDueCarried)}  fees ${money(s.penaltiesFees)}  ` +
            `${s.pdfS3Key ? 'pdf' : 'no pdf'}`
          );
        }

        // Gaps in the sequence, judged on the period billed. A missing month is
        // the thing people come here to find, so say it rather than leaving it
        // to be spotted in a list of forty rows.
        const periods = statements
          .map(s => s.billingPeriodEnd ?? s.statementDate)
          .sort((x, y) => x.getTime() - y.getTime());
        const gaps: string[] = [];
        for (let i = 1; i < periods.length; i++) {
          const days = Math.round((periods[i].getTime() - periods[i - 1].getTime()) / 86400000);
          if (days > 45) gaps.push(`${day(periods[i - 1])} → ${day(periods[i])} (${days} days)`);
        }
        if (gaps.length) {
          console.log(`\n    ⚠ ${gaps.length} gap(s) longer than 45 days between billed periods:`);
          gaps.forEach(g => console.log(`        ${g}`));
        }
      }
    }

    console.log(`\n  TOTAL for this property: ${total} statement(s) across ${accounts.length} account(s)`);
  }

  // Anything imported very recently, wherever it landed. If an import wrote
  // rows against the wrong property this is where that shows up.
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const recent = await db.statement.findMany({
    where: { createdAt: { gte: since } },
    select: {
      createdAt: true,
      utilityAccount: {
        select: { providerName: true, property: { select: { address: true, nickname: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`\n─── Statements created in the last 6 hours: ${recent.length} ───`);
  const grouped = new Map<string, number>();
  for (const r of recent) {
    const key = `${r.utilityAccount.property.nickname || r.utilityAccount.property.address} · ${r.utilityAccount.providerName}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...grouped].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(4)}  ${key}`);
  }
  if (recent.length === 0) console.log('  (none — nothing was written)');

  await db.$disconnect();
})().catch(async e => {
  console.error('Failed:', e.message);
  await db.$disconnect();
  process.exit(1);
});
