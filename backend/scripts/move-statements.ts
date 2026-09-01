/**
 * Moves statements from one utility account to another.
 *
 * The companion to audit-statement-placement.ts: that finds bills filed under
 * the wrong account, this relocates them. Re-importing the PDFs would also
 * work, but it means finding forty files again — the rows already hold the
 * right data and their own PDFs, so moving them preserves everything.
 *
 * Usage, from backend/:
 *   # Everything the audit flagged for one service address:
 *   npx tsx scripts/move-statements.ts --from <accountId> --to <accountId> \
 *     --address "488 H ST"
 *
 *   # Or a specific list of ids:
 *   npx tsx scripts/move-statements.ts --to <accountId> --ids id1,id2,id3
 *
 *   Add --apply to write. Dry run by default.
 *
 * A month already present on the destination is left alone and reported
 * rather than overwritten — the same collision that caused this mess.
 */
import 'dotenv/config';
import { db } from '../src/config/db';

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const FROM = getArg('from');
const TO = getArg('to');
const ADDRESS = getArg('address');
const IDS = (getArg('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
const APPLY = args.includes('--apply');

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

(async () => {
  if (!TO || (!IDS.length && !(FROM && ADDRESS))) {
    console.error('Usage: --to <accountId> [--from <accountId> --address "488 H ST" | --ids id1,id2] [--apply]');
    process.exit(1);
  }

  const target = await db.utilityAccount.findUnique({
    where: { id: TO },
    select: { id: true, providerName: true, category: true, property: { select: { address: true, nickname: true } } },
  });
  if (!target) { console.error(`No account with id ${TO}`); process.exit(1); }

  // Select by explicit ids, or by what the bill says its service address was.
  let candidates = await db.statement.findMany({
    where: IDS.length ? { id: { in: IDS } } : { utilityAccountId: FROM },
    select: { id: true, statementDate: true, amountDue: true, rawDataJson: true, utilityAccountId: true },
    orderBy: { statementDate: 'asc' },
  });

  if (!IDS.length && ADDRESS) {
    const needle = ADDRESS.toLowerCase().replace(/[^a-z0-9]/g, '');
    candidates = candidates.filter(s => {
      const raw = s.rawDataJson as Record<string, unknown> | null;
      const addr = typeof raw?.serviceAddress === 'string' ? raw.serviceAddress : '';
      return addr.toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle);
    });
  }

  if (candidates.length === 0) {
    console.log('Nothing matched — no statements to move.');
    await db.$disconnect();
    return;
  }

  const existing = await db.statement.findMany({
    where: { utilityAccountId: TO },
    select: { statementDate: true },
  });
  const occupied = new Set(existing.map(s => monthKey(s.statementDate)));

  console.log(APPLY ? '── APPLYING ──\n' : '── DRY RUN (pass --apply to write) ──\n');
  console.log(`Destination: ${target.providerName} [${target.category}] at ` +
    `${target.property.nickname || target.property.address}\n`);

  let moved = 0, blocked = 0;
  for (const s of candidates) {
    const key = monthKey(s.statementDate);
    const label = `${s.statementDate.toISOString().slice(0, 10)}  ` +
      `${s.amountDue != null ? '$' + Number(s.amountDue).toFixed(2) : '—'}`;

    if (occupied.has(key)) {
      // Overwriting here would repeat the original fault. Report and skip.
      console.log(`  SKIP  ${label}  — ${key} already exists on the destination`);
      blocked++;
      continue;
    }

    console.log(`  move  ${label}`);
    if (APPLY) {
      await db.statement.update({ where: { id: s.id }, data: { utilityAccountId: TO } });
    }
    occupied.add(key);
    moved++;
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`${moved} statement(s) ${APPLY ? 'moved' : 'would move'}, ${blocked} skipped as already present.`);
  if (blocked > 0) {
    console.log('Skipped months exist on both accounts. Compare the two PDFs and delete');
    console.log('whichever is wrong before moving the remainder.');
  }
  if (!APPLY && moved > 0) console.log('\nRe-run with --apply to perform the move.');

  await db.$disconnect();
})().catch(async e => {
  console.error('Failed:', e.message);
  await db.$disconnect();
  process.exit(1);
});
