/**
 * Reports what the Prisma schema expects that the database does not have.
 *
 * Exists because "No pending migrations to apply" is not proof the schema is
 * correct. A migration recorded in _prisma_migrations whose DDL never landed
 * leaves the database short of columns while Prisma believes it is up to date,
 * and the only symptom is a P2022 at runtime. Running migrations through a
 * pooled connection (a Neon "-pooler" host) is the usual cause.
 *
 * Usage, from backend/:
 *   npx tsx scripts/check-schema-drift.ts
 *
 * Reads DATABASE_URL from .env. Read-only — it inspects information_schema and
 * changes nothing.
 *
 * The expected shape comes from Prisma's own DMMF rather than from parsing
 * schema.prisma: the generated client already knows which fields are real
 * columns, which are relations, and what each maps to in the database.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { PrismaClient, Prisma } from '@prisma/client';

const db = new PrismaClient();

/**
 * Migrations on disk that the database has not recorded.
 *
 * Checked separately from the column comparison below, and first, because the
 * column comparison is only as current as the generated client: it reads the
 * expected shape from Prisma.dmmf, so a client generated before the latest
 * schema change does not know the new columns exist and cannot report them
 * missing. That failure mode is silent and reports success — the worst kind.
 * The migration folders are on disk regardless of when the client was built.
 */
async function checkPendingMigrations(): Promise<number> {
  const dir = path.join(__dirname, '..', 'prisma', 'migrations');
  if (!fs.existsSync(dir)) return 0;

  const onDisk = fs.readdirSync(dir)
    .filter(name => fs.statSync(path.join(dir, name)).isDirectory())
    .sort();

  let applied: Set<string>;
  try {
    const rows = await db.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
      SELECT migration_name, finished_at FROM "_prisma_migrations"
    `;
    applied = new Set(rows.filter(r => r.finished_at != null).map(r => r.migration_name));
  } catch {
    console.log('⚠  No _prisma_migrations table — this database has never had migrations applied.');
    return onDisk.length;
  }

  const pending = onDisk.filter(name => !applied.has(name));
  if (pending.length) {
    console.log(`✗ ${pending.length} migration(s) on disk are not applied to this database:`);
    pending.forEach(name => console.log(`    ${name}`));
    console.log('  Run: npx prisma migrate deploy');
  }
  return pending.length;
}

(async () => {
  const url = process.env.DATABASE_URL ?? '';
  const host = url.match(/@([^/:]+)/)?.[1] ?? 'unknown';
  console.log(`Database host: ${host}`);
  if (host.includes('-pooler')) {
    console.log('  ⚠  This is a POOLED host. Prisma migrations need the direct one');
    console.log('     (drop "-pooler" from the hostname) — DDL and advisory locks');
    console.log('     do not behave through PgBouncer.');
  }
  console.log('');

  const rows = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `;
  const actual = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
    actual.get(r.table_name)!.add(r.column_name);
  }

  let problems = await checkPendingMigrations();
  if (problems > 0) console.log('');

  for (const model of Prisma.dmmf.datamodel.models) {
    const table = model.dbName ?? model.name;
    // Only scalar and enum fields are columns; object fields are relations and
    // live as foreign keys that appear as scalars in their own right.
    const columns = model.fields
      .filter(f => f.kind === 'scalar' || f.kind === 'enum')
      .map(f => f.dbName ?? f.name);

    const have = actual.get(table);
    if (!have) {
      console.log(`✗ TABLE MISSING: ${table}  (model ${model.name})`);
      problems++;
      continue;
    }
    const missing = columns.filter(c => !have.has(c));
    if (missing.length) {
      console.log(`✗ ${table}  (model ${model.name}) missing column(s): ${missing.join(', ')}`);
      problems++;
    }
  }

  // Enum values matter too: an ALTER TYPE ... ADD VALUE that never ran leaves
  // writes failing rather than reads.
  const enumRows = await db.$queryRaw<{ enum_name: string; value: string }[]>`
    SELECT t.typname AS enum_name, e.enumlabel AS value
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
  `;
  const actualEnums = new Map<string, Set<string>>();
  for (const e of enumRows) {
    if (!actualEnums.has(e.enum_name)) actualEnums.set(e.enum_name, new Set());
    actualEnums.get(e.enum_name)!.add(e.value);
  }

  for (const en of Prisma.dmmf.datamodel.enums) {
    const name = en.dbName ?? en.name;
    const have = actualEnums.get(name);
    if (!have) {
      console.log(`✗ ENUM MISSING: ${name}`);
      problems++;
      continue;
    }
    const missing = en.values.map(v => v.dbName ?? v.name).filter(v => !have.has(v));
    if (missing.length) {
      console.log(`✗ enum ${name} missing value(s): ${missing.join(', ')}`);
      problems++;
    }
  }

  // Say what was actually verified. "Matches the schema" overstates it when
  // the client the comparison came from may itself be out of date.
  console.log(problems === 0
    ? `✓ ${Prisma.dmmf.datamodel.models.length} model(s) checked against the database, no migrations pending.\n` +
      '  (Run `npx prisma generate` first if you have just pulled a schema change —\n' +
      '   this compares against the generated client, not schema.prisma.)'
    : `\n${problems} problem(s) — this is what P2022 is reporting.`);

  await db.$disconnect();
})().catch(async e => {
  console.error('Failed:', e.message);
  await db.$disconnect();
  process.exit(1);
});
