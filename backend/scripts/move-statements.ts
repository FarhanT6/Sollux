/**
 * Moves statements from one utility account to another.
 *
 * The companion to audit-statement-placement.ts: that finds bills filed under
 * the wrong account, this relocates them. Re-importing the PDFs would also
 * work, but it means finding forty files again — the rows already hold the
 * right data and their own PDFs, so moving them preserves everything.
 *
 * Usage, from backend/:
 *   # Everything the audit flagged for one service address. The destination is
 *   # named rather than passed as an id, so nothing has to be copied between
 *   # commands:
 *   npx tsx scripts/move-statements.ts --from ACCOUNT_ID \
 *     --to-property "De Anza" --to-provider IID --address "488 H ST"
 *
 *   # Or by id, or a specific list of statements:
 *   npx tsx scripts/move-statements.ts --to ACCOUNT_ID --ids id1,id2,id3
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
// Either the destination account's id, or the property and provider to find
// it by — copying a cuid between two terminal commands is its own source of
// mistakes, and shell metacharacters in a pasted placeholder fail obscurely.
const TO_ARG = getArg('to');
const TO_PROPERTY = getArg('to-property');
const TO_PROVIDER = getArg('to-provider');
const ADDRESS = getArg('address');
const IDS = (getArg('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
const APPLY = args.includes('--apply');

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** Resolve the destination from a property name plus provider. */
async function findTargetAccount() {
  if (TO_ARG) {
    return db.utilityAccount.findUnique({
      where: { id: TO_ARG },
      select: { id: true, providerName: true, serviceLabel: true, category: true, property: { select: { address: true, nickname: true } } },
    });
  }

  const properties = await db.property.findMany({
    where: {
      OR: [
        { address: { contains: TO_PROPERTY!, mode: 'insensitive' } },
        { nickname: { contains: TO_PROPERTY!, mode: 'insensitive' } },
      ],
    },
    select: { id: true, address: true, nickname: true },
  });
  if (properties.length === 0) {
    console.error(`No property matches "${TO_PROPERTY}".`);
    process.exit(1);
  }
  if (properties.length > 1) {
    console.error(`"${TO_PROPERTY}" matches ${properties.length} properties:`);
    properties.forEach(p => console.error(`  ${p.nickname || p.address}`));
    console.error('Narrow it down.');
    process.exit(1);
  }

  const accounts = await db.utilityAccount.findMany({
    where: {
      propertyId: properties[0].id,
      ...(TO_PROVIDER ? { providerName: { contains: TO_PROVIDER, mode: 'insensitive' } } : {}),
    },
    select: { id: true, providerName: true, serviceLabel: true, category: true, property: { select: { address: true, nickname: true } } },
  });
  if (accounts.length === 0) {
    console.error(`No ${TO_PROVIDER ?? ''} account on ${properties[0].nickname || properties[0].address}. Create it first.`);
    process.exit(1);
  }
  if (accounts.length > 1) {
    // Several meters for one provider is exactly the situation this script
    // exists to clean up, so refuse rather than pick.
    console.error(`${accounts.length} matching accounts on ${properties[0].nickname || properties[0].address}:`);
    accounts.forEach(a => console.error(`  ${a.providerName}${a.serviceLabel ? ` — ${a.serviceLabel}` : ''} [${a.category}]  id ${a.id}`));
    console.error('Pass one with --to <id>.');
    process.exit(1);
  }
  return accounts[0];
}

(async () => {
  const haveDestination = TO_ARG || TO_PROPERTY;
  if (!haveDestination || (!IDS.length && !(FROM && ADDRESS))) {
    console.error('Usage:');
    console.error('  --to-property "De Anza" --to-provider IID --from <accountId> --address "488 H ST"');
    console.error('  --to <accountId> --ids id1,id2');
    console.error('Add --apply to write. Dry run by default.');
    process.exit(1);
  }

  const target = await findTargetAccount();
  if (!target) { console.error(`No account with id ${TO_ARG}`); process.exit(1); }
  const TO = target.id;

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
  console.log(`Destination: ${target.providerName}${target.serviceLabel ? ` — ${target.serviceLabel}` : ''} ` +
    `[${target.category}] at ${target.property.nickname || target.property.address}`);
  console.log(`            id ${TO}\n`);

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
