/**
 * Reports columns the Prisma schema expects that the database does not have.
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
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const db = new PrismaClient();

// Pull the expected shape straight from schema.prisma rather than hardcoding a
// list, so this stays accurate as the schema grows.
function expectedColumns(): Map<string, { fields: string[]; model: string }> {
  const schema = fs.readFileSync(path.resolve(__dirname, '../prisma/schema.prisma'), 'utf-8');
  const out = new Map<string, { fields: string[]; model: string }>();

  for (const block of schema.split(/\nmodel\s+/).slice(1)) {
    const model = block.slice(0, block.indexOf(' ')).trim();
    const body = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
    const mapMatch = body.match(/@@map\("([^"]+)"\)/);
    const table = mapMatch ? mapMatch[1] : model;

    const fields: string[] = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;

      const m = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
      if (!m) continue;
      const [, name, type, isList] = m;

      // Relation fields are not columns. A list is always a relation; a scalar
      // relation is the one carrying @relation, whose foreign key is a separate
      // field that we do pick up.
      if (isList) continue;
      if (line.includes('@relation(')) continue;

      const scalar = /^(String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes)$/.test(type);
      const isEnumOrScalar = scalar || /^[A-Z]/.test(type);
      if (!isEnumOrScalar) continue;

      const column = line.match(/@map\("([^"]+)"\)/)?.[1] ?? name;
      fields.push(column);
    }
    out.set(table, { fields, model });
  }
  return out;
}

(async () => {
  const url = process.env.DATABASE_URL ?? '';
  const host = url.match(/@([^/:]+)/)?.[1] ?? 'unknown';
  console.log(`Database host: ${host}`);
  if (host.includes('-pooler')) {
    console.log('  ⚠  This is a POOLED host. Prisma migrations need the direct one');
    console.log('     (drop "-pooler" from the hostname) — DDL and advisory locks');
    console.log('     do not behave through PgBouncer.\n');
  }

  const expected = expectedColumns();

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

  let problems = 0;
  for (const [table, { fields, model }] of expected) {
    const have = actual.get(table);
    if (!have) {
      console.log(`✗ TABLE MISSING: ${table}  (model ${model})`);
      problems++;
      continue;
    }
    const missing = fields.filter(f => !have.has(f));
    if (missing.length) {
      console.log(`✗ ${table}  (model ${model}) missing: ${missing.join(', ')}`);
      problems++;
    }
  }

  // Enum values are the other half of the story: ALTER TYPE ... ADD VALUE that
  // never ran leaves writes failing rather than reads.
  const enums = await db.$queryRaw<{ enum_name: string; value: string }[]>`
    SELECT t.typname AS enum_name, e.enumlabel AS value
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
  `;
  const enumValues = new Map<string, Set<string>>();
  for (const e of enums) {
    if (!enumValues.has(e.enum_name)) enumValues.set(e.enum_name, new Set());
    enumValues.get(e.enum_name)!.add(e.value);
  }

  const schemaText = fs.readFileSync(path.resolve(__dirname, '../prisma/schema.prisma'), 'utf-8');
  for (const block of schemaText.split(/\nenum\s+/).slice(1)) {
    const name = block.slice(0, block.indexOf(' ')).trim();
    const body = block.slice(block.indexOf('{') + 1, block.indexOf('}'));
    const wanted = body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
    const have = enumValues.get(name);
    if (!have) { console.log(`✗ ENUM MISSING: ${name}`); problems++; continue; }
    const missing = wanted.filter(v => !have.has(v));
    if (missing.length) { console.log(`✗ enum ${name} missing values: ${missing.join(', ')}`); problems++; }
  }

  console.log(problems === 0
    ? '\n✓ Database matches the Prisma schema.'
    : `\n${problems} problem(s). These are what P2022 is complaining about.`);

  await db.$disconnect();
})().catch(async e => {
  console.error('Failed:', e.message);
  await db.$disconnect();
  process.exit(1);
});
