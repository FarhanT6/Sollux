/**
 * Merges utility accounts that are really the same account.
 *
 * The bulk importer used to create one account per bill (a check-then-act race
 * fixed in utilityAccountResolver.ts), leaving properties with several accounts
 * for one provider, each holding a single statement. This consolidates them.
 *
 * Usage, from backend/:
 *   npx tsx scripts/merge-duplicate-accounts.ts                 # dry run
 *   npx tsx scripts/merge-duplicate-accounts.ts --property <id> # one property
 *   npx tsx scripts/merge-duplicate-accounts.ts --apply         # actually merge
 *
 * Dry run by default. Nothing is written without --apply.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const PROPERTY_ID = process.argv[process.argv.indexOf('--property') + 1];
const ONLY_PROPERTY = process.argv.includes('--property') ? PROPERTY_ID : null;

// The importer's own matcher, so this consolidates exactly what it would
// treat as one account — acronyms and abbreviations included.
import { providersLookAlike as alike } from '../src/services/providerMatch';

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** How much real information a statement carries, for choosing between duplicates. */
function richness(s: { amountDue: any; dueDate: any; pdfS3Key: any; usageValue: any; rawDataJson: any }) {
  return (s.amountDue != null ? 2 : 0) + (s.dueDate != null ? 1 : 0)
    + (s.pdfS3Key ? 2 : 0) + (s.usageValue != null ? 1 : 0) + (s.rawDataJson ? 1 : 0);
}

(async () => {
  console.log(APPLY ? '── APPLYING MERGES ──\n' : '── DRY RUN (pass --apply to write) ──\n');

  const properties = await db.property.findMany({
    where: ONLY_PROPERTY ? { id: ONLY_PROPERTY } : {},
    select: {
      id: true, address: true, nickname: true,
      utilityAccounts: {
        select: {
          id: true, providerName: true, providerSlug: true, category: true,
          accountNumberEnc: true, usernameEnc: true, createdAt: true,
          _count: { select: { statements: true, payments: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  let groupsFound = 0, accountsRemoved = 0, statementsMoved = 0, statementsDropped = 0;

  for (const property of properties) {
    // Group by category, then cluster on provider name within each.
    const byCategory = new Map<string, typeof property.utilityAccounts>();
    for (const a of property.utilityAccounts) {
      const list = byCategory.get(a.category) ?? [];
      list.push(a);
      byCategory.set(a.category, list);
    }

    for (const [category, accounts] of byCategory) {
      const unclustered = [...accounts];
      while (unclustered.length > 0) {
        const seed = unclustered.shift()!;
        const cluster = [seed];
        for (let i = unclustered.length - 1; i >= 0; i--) {
          if (alike(unclustered[i].providerName, seed.providerName)) {
            cluster.push(unclustered.splice(i, 1)[0]);
          }
        }
        if (cluster.length < 2) continue;

        groupsFound++;
        // Keep the account carrying the most: credentials first (those were set
        // up by hand and are hard to recreate), then account number, then the
        // most statements, then the oldest.
        cluster.sort((a, b) =>
          Number(!!b.usernameEnc) - Number(!!a.usernameEnc) ||
          Number(!!b.accountNumberEnc) - Number(!!a.accountNumberEnc) ||
          b._count.statements - a._count.statements ||
          a.createdAt.getTime() - b.createdAt.getTime());
        const [survivor, ...doomed] = cluster;

        console.log(`${property.nickname || property.address} · ${category}`);
        console.log(`  keep   ${survivor.providerName} (${survivor._count.statements} stmts, ${survivor._count.payments} pmts)${survivor.usernameEnc ? ' [has credentials]' : ''}`);
        for (const d of doomed) {
          console.log(`  merge  ${d.providerName} (${d._count.statements} stmts, ${d._count.payments} pmts)`);
        }

        if (!APPLY) { accountsRemoved += doomed.length; continue; }

        // Existing months on the survivor, so a duplicate month doesn't collide.
        const survivorStatements = await db.statement.findMany({
          where: { utilityAccountId: survivor.id },
          select: { id: true, statementDate: true, amountDue: true, dueDate: true, pdfS3Key: true, usageValue: true, rawDataJson: true },
        });
        const byMonth = new Map(survivorStatements.map(s => [monthKey(s.statementDate), s]));

        for (const d of doomed) {
          const moving = await db.statement.findMany({
            where: { utilityAccountId: d.id },
            select: { id: true, statementDate: true, amountDue: true, dueDate: true, pdfS3Key: true, usageValue: true, rawDataJson: true },
          });

          for (const stmt of moving) {
            const key = monthKey(stmt.statementDate);
            const clash = byMonth.get(key);
            if (!clash) {
              await db.statement.update({ where: { id: stmt.id }, data: { utilityAccountId: survivor.id } });
              byMonth.set(key, stmt);
              statementsMoved++;
              continue;
            }
            // Same month on both. Keep whichever carries more, drop the other —
            // these are the same bill imported twice, not two different bills.
            if (richness(stmt) > richness(clash)) {
              await db.statement.delete({ where: { id: clash.id } });
              await db.statement.update({ where: { id: stmt.id }, data: { utilityAccountId: survivor.id } });
              byMonth.set(key, stmt);
              statementsMoved++;
            } else {
              await db.statement.delete({ where: { id: stmt.id } });
            }
            statementsDropped++;
          }

          await db.payment.updateMany({ where: { utilityAccountId: d.id }, data: { utilityAccountId: survivor.id } });
          await db.aIInsight.updateMany({ where: { utilityAccountId: d.id }, data: { utilityAccountId: survivor.id } });
          await db.outgoingTransaction.updateMany({ where: { utilityAccountId: d.id }, data: { utilityAccountId: survivor.id } });

          // Carry over an account number the survivor lacks — without it the
          // importer can never match this account by number again.
          if (d.accountNumberEnc && !survivor.accountNumberEnc) {
            await db.utilityAccount.update({
              where: { id: survivor.id },
              data: { accountNumberEnc: d.accountNumberEnc },
            });
          }

          await db.utilityAccount.delete({ where: { id: d.id } });
          accountsRemoved++;
        }
        console.log('');
      }
    }
  }

  console.log('─'.repeat(50));
  console.log(`${groupsFound} duplicate group(s)`);
  console.log(`${accountsRemoved} account(s) ${APPLY ? 'merged away' : 'would be merged away'}`);
  if (APPLY) {
    console.log(`${statementsMoved} statement(s) moved, ${statementsDropped} duplicate month(s) resolved`);
  } else if (groupsFound > 0) {
    console.log('\nRe-run with --apply to perform the merge.');
  }

  await db.$disconnect();
})().catch(async e => {
  console.error('Failed:', e.message);
  await db.$disconnect();
  process.exit(1);
});
