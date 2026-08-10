// Bulk-imports a local folder of statement PDFs into Sollux without going
// through the Google Drive picker's AI extraction (that costs Claude API
// credits per file). This uses FREE regex-based extraction only.
//
// Expects the folder to be organized as:
//   <root>/<CategoryFolderName>/[<Year>/]<file>.pdf
// e.g. a Drive "Bills" folder downloaded as a zip and extracted:
//   Bills/Water/2024/3-24-24.pdf
//   Bills/Water/2025/4-23-25.pdf
//   Bills/Insurance/2025_26_....pdf
//
// CategoryFolderName is mapped to a UtilityCategory via CATEGORY_FOLDER_MAP
// below (case-insensitive substring match) — edit it if your folder names
// don't match. Folders matching PERSONAL_FOLDERS (also below) are imported
// as personal Expense rows instead (no property, isPersonal: true) rather
// than a property-tied utility account — for things like a cemetery plot
// or a printer subscription that aren't a property bill. Folders that
// don't match anything are skipped and listed at the end so nothing is
// silently dropped.
//
// For each PDF:
//   1. Extract fields with the same regex parser the app's "Free mode"
//      Drive import uses (no AI, no cost).
//   2a. Utility folders: find an existing UtilityAccount for (property,
//       category) — matched loosely by provider name if there are several;
//       auto-created if none exists yet (mirrors what the in-app Drive
//       import does automatically for a matched property with no account).
//       Upload the PDF to S3 and create/update the Statement row for that
//       billing month (idempotent — re-running won't duplicate).
//   2b. Personal folders: create a personal Expense row (amount + date
//       extracted from the PDF, no property). Deduped on re-run by
//       (vendor, date, amount).
//
// Usage (run from backend/, with your real env vars — same DATABASE_URL you
// already use for `prisma migrate deploy`, plus AWS_* creds for S3):
//
//   DATABASE_URL=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
//     npx tsx scripts/import-local-statements.ts \
//     --dir /path/to/Bills --email you@example.com --property "4349 Vista Verde Way"
//
//   Add --dry-run to preview matches/creates without writing anything.
//   Add --ai to use Claude extraction instead of regex (costs credits,
//   generally more accurate) for files regex struggles with.

import fs from 'fs';
import path from 'path';
import { PrismaClient, Prisma } from '@prisma/client';
import { parseBill } from '../src/services/pdfImportService';
import { uploadDocument, buildStatementKey } from '../src/services/s3Service';

const db = new PrismaClient();

const CATEGORY_FOLDER_MAP: Record<string, string> = {
  water: 'WATER',
  electric: 'ELECTRIC', electricity: 'ELECTRIC',
  gas: 'GAS',
  sewer: 'SEWER',
  trash: 'TRASH', waste: 'TRASH',
  solar: 'SOLAR',
  internet: 'INTERNET', cox: 'INTERNET', spectrum: 'INTERNET',
  phone: 'PHONE', landline: 'PHONE', cellphone: 'PHONE', cellphones: 'PHONE', att: 'PHONE', 'at&t': 'PHONE',
  insurance: 'INSURANCE',
  hoa: 'HOA',
  tax: 'TAXES', taxes: 'TAXES',
  loan: 'LOAN', mortgage: 'LOAN', car: 'LOAN', cars: 'LOAN', auto: 'LOAN',
  'credit card': 'CREDIT_CARD', 'credit cards': 'CREDIT_CARD',
};

// Folders imported as personal Expense rows (no property) instead of a
// utility account — edit freely for your own folder names.
const PERSONAL_FOLDERS = ['eternal hills', 'hp instant ink'];

function isPersonalFolder(folderName: string): boolean {
  const lower = folderName.toLowerCase();
  return PERSONAL_FOLDERS.some(f => lower.includes(f));
}

// Files matching one of these (checked against the full path relative to
// --dir, so subfolder names count too) aren't statements at all — tax
// forms, insurance policy paperwork, inspection reports, recall notices,
// etc. — so they're saved as Documents (Portfolio → Documents) instead of
// being forced into a Statement row. Order matters: first match wins.
const DOCUMENT_MARKERS: { pattern: RegExp; category: string }[] = [
  { pattern: /1098|1099/i, category: 'TAX' },
  { pattern: /declarations? page|id ?card|verification of insurance|payment schedule|cancel(l)?ation? notice|eft ?authorization|election of lower limits|policy ?notice|cover letter|application/i, category: 'INSURANCE' },
  { pattern: /recall|inspection|servicecart|dealership visit|product recall/i, category: 'OTHER' },
];

function documentMarkerFor(relPath: string): string | null {
  for (const { pattern, category } of DOCUMENT_MARKERS) {
    if (pattern.test(relPath)) return category;
  }
  return null;
}

function categoryForFolder(folderName: string): string | null {
  const lower = folderName.toLowerCase();
  for (const [key, category] of Object.entries(CATEGORY_FOLDER_MAP)) {
    // Word-boundary match, not a raw substring check — otherwise short keys
    // like "car" false-positive inside unrelated words (e.g. "Credit Cards"
    // contains "car" as a literal substring of "cards").
    if (new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) return category;
  }
  return null;
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function parseDateFromFilename(filename: string): Date | null {
  const name = filename.replace(/\.[^.]+$/, '');
  const m = name.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{2,4})/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const d = new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
    if (!isNaN(d.getTime()) && d.getFullYear() >= 2000) return d;
  }
  return null;
}

function walkPdfs(root: string): { categoryFolder: string; filePath: string; filename: string; relPath: string }[] {
  const out: { categoryFolder: string; filePath: string; filename: string; relPath: string }[] = [];
  for (const categoryFolder of fs.readdirSync(root)) {
    const categoryPath = path.join(root, categoryFolder);
    if (!fs.statSync(categoryPath).isDirectory()) continue;

    const stack = [categoryPath];
    while (stack.length) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current)) {
        const full = path.join(current, entry);
        if (fs.statSync(full).isDirectory()) {
          stack.push(full);
        } else if (entry.toLowerCase().endsWith('.pdf')) {
          out.push({ categoryFolder, filePath: full, filename: entry, relPath: path.relative(root, full) });
        }
      }
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = getArg('dir');
  const email = getArg('email');
  const propertyQuery = getArg('property');
  const dryRun = args.includes('--dry-run');
  const method: 'ai' | 'regex' = args.includes('--ai') ? 'ai' : 'regex';
  // Comma-separated list of substrings to exclude — matched against both
  // the top-level category folder name and each file's full relative path,
  // so this can drop an entire folder (e.g. "Cars") or just specific loose
  // files within one (e.g. "Myaccount.pdf,chase.com").
  const skipFolders = (getArg('skip') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  if (!dir || !email || !propertyQuery) {
    console.error('Usage: npx tsx scripts/import-local-statements.ts --dir <path> --email <you@example.com> --property "<address or nickname>" [--dry-run] [--ai]');
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
    console.error(`No property matching "${propertyQuery}" found. Properties on file: ${properties.map(p => p.nickname || p.address).join(', ')}`);
    process.exit(1);
  }
  console.log(`Property: ${property.nickname || property.address} (${property.id})`);

  const allFiles = walkPdfs(dir);
  const files = allFiles.filter(f => !skipFolders.some(s =>
    f.categoryFolder.toLowerCase().includes(s) || f.relPath.toLowerCase().includes(s)
  ));
  const excludedCount = allFiles.length - files.length;
  console.log(`Found ${allFiles.length} PDFs across ${new Set(allFiles.map(f => f.categoryFolder)).size} folders. Method: ${method}${dryRun ? ' (DRY RUN)' : ''}`);
  if (excludedCount > 0) console.log(`Excluding ${excludedCount} files matching --skip: ${skipFolders.join(', ')}`);
  console.log('');

  const skippedFolders = new Set<string>();
  let imported = 0, updated = 0, skipped = 0, errored = 0, personalImported = 0, personalSkipped = 0;
  let docsImported = 0, docsSkipped = 0;

  for (const file of files) {
    const docCategory = documentMarkerFor(file.relPath);
    if (docCategory) {
      try {
        const title = file.filename.replace(/\.pdf$/i, '');
        const existingDoc = await db.document.findFirst({
          where: { userId: user.id, propertyId: property.id, title },
        });
        if (existingDoc) {
          console.log(`  [doc, skip exists] ${file.relPath}`);
          docsSkipped++;
          continue;
        }

        console.log(`  [document, ${docCategory}] ${file.relPath}`);
        if (!dryRun) {
          const buffer = fs.readFileSync(file.filePath);
          const key = `${user.id}/documents/${property.id}/${Date.now()}_${sanitizeFilename(file.filename)}`;
          const s3Url = await uploadDocument(key, buffer);
          await db.document.create({
            data: {
              userId: user.id,
              propertyId: property.id,
              category: docCategory as any,
              title,
              s3Key: key,
              s3Url,
              sourceType: 'UPLOAD',
              notes: `Imported from ${file.relPath}`,
            },
          });
        }
        docsImported++;
      } catch (err) {
        errored++;
        console.error(`  ERROR on ${file.filePath}:`, err instanceof Error ? err.message : err);
      }
      continue;
    }

    if (isPersonalFolder(file.categoryFolder)) {
      try {
        const buffer = fs.readFileSync(file.filePath);
        const { extracted: ex } = await parseBill(buffer, file.filename, user.id, method);
        const filenameDate = parseDateFromFilename(file.filename);
        const date = ex.statementDate ? new Date(ex.statementDate) : (filenameDate ?? new Date());
        const amount = ex.amountDue ?? ex.currentCharges ?? 0;
        const vendor = ex.providerName || file.categoryFolder;

        const existing = await db.expense.findFirst({
          where: { userId: user.id, isPersonal: true, vendor, date, amount },
        });
        if (existing) {
          console.log(`  [skip, exists] ${file.categoryFolder}/${file.filename}`);
          personalSkipped++;
          continue;
        }

        console.log(`  [personal expense] ${file.categoryFolder}/${file.filename} -> ${date.toISOString().slice(0, 10)}, ${amount}`);
        if (!dryRun) {
          await db.expense.create({
            data: {
              userId: user.id,
              propertyId: null,
              category: 'OTHER',
              amount,
              date,
              vendor,
              description: file.filename,
              isPersonal: true,
            },
          });
        }
        personalImported++;
      } catch (err) {
        errored++;
        console.error(`  ERROR on ${file.filePath}:`, err instanceof Error ? err.message : err);
      }
      continue;
    }

    const category = categoryForFolder(file.categoryFolder);
    if (!category) { skippedFolders.add(file.categoryFolder); skipped++; continue; }

    try {
      const buffer = fs.readFileSync(file.filePath);
      const { extracted: ex } = await parseBill(buffer, file.filename, user.id, method);

      // Resolve the utility account explicitly by (property, category) — we
      // already know both from the folder structure, which is more reliable
      // than the extractor's generic address-matching for docs (loan
      // statements, HOA notices) that don't mention the property address.
      let account = await db.utilityAccount.findFirst({
        where: {
          propertyId: property.id,
          category: category as any,
          ...(ex.providerName ? { providerName: { contains: ex.providerName, mode: 'insensitive' } } : {}),
        },
      });
      if (!account) {
        account = await db.utilityAccount.findFirst({ where: { propertyId: property.id, category: category as any } });
      }

      if (!account) {
        const providerName = ex.providerName || file.categoryFolder;
        console.log(`  [create account] ${category} / ${providerName}`);
        if (!dryRun) {
          account = await db.utilityAccount.create({
            data: {
              propertyId: property.id,
              providerName,
              providerSlug: toSlug(providerName),
              category: category as any,
            },
          });
        }
      }

      const filenameDate = parseDateFromFilename(file.filename);
      const statementDate = ex.statementDate ? new Date(ex.statementDate) : (filenameDate ?? new Date());
      const totalDue = (ex.currentCharges != null || ex.previousBalance != null)
        ? (ex.currentCharges ?? 0) + (ex.previousBalance ?? 0)
        : ex.amountDue;
      const amountDueCurrent = ex.currentCharges ?? ex.amountDue;

      const pastDueAmt = ex.previousBalance != null && ex.previousBalance > 0 ? ex.previousBalance : null;
      console.log(
        `  ${file.categoryFolder}/${file.filename} -> ${statementDate.toISOString().slice(0, 10)}, ` +
        `due ${amountDueCurrent ?? '—'}` +
        (pastDueAmt != null ? `, past due ${pastDueAmt}` : '') +
        (ex.lateFee != null ? `, late fee ${ex.lateFee}` : '') +
        (ex.dueDate ? `, due date ${ex.dueDate}` : '') +
        (ex.billingPeriodStart || ex.billingPeriodEnd ? `, period ${ex.billingPeriodStart ?? '?'}–${ex.billingPeriodEnd ?? '?'}` : '') +
        (ex.usageValue != null ? `, usage ${ex.usageValue}${ex.usageUnit ?? ''}` : '')
      );

      if (dryRun || !account) { imported++; continue; }

      const monthStart = new Date(statementDate.getFullYear(), statementDate.getMonth(), 1);
      const monthEnd = new Date(statementDate.getFullYear(), statementDate.getMonth() + 1, 0, 23, 59, 59);
      const existing = await db.statement.findFirst({
        where: { utilityAccountId: account.id, statementDate: { gte: monthStart, lte: monthEnd } },
      });

      const s3Key = buildStatementKey(user.id, property.id, account.id, statementDate, sanitizeFilename(file.filename));
      const pdfS3Key = await uploadDocument(s3Key, buffer);

      const rawData: Record<string, unknown> = {
        source: 'local_import', providerName: ex.providerName, serviceAddress: ex.serviceAddress,
        accountNumber: ex.accountNumber, previousBalance: ex.previousBalance,
        paymentsReceived: ex.paymentsReceived, currentCharges: ex.currentCharges, totalDue,
        pastDue: pastDueAmt ?? undefined,
        isPaid: ex.isPaid, utilityType: ex.utilityType, chargeBreakdown: ex.chargeBreakdown, alerts: ex.alerts,
      };
      // Prefer the actual payment amount the statement shows over guessing
      // "fully paid" from the isPaid flag — that flag only tells us whether
      // the balance was zeroed out, not how much was actually paid.
      const amountPaidValue = ex.paymentsReceived ?? (ex.isPaid ? (totalDue ?? amountDueCurrent ?? null) : null);

      if (existing) {
        await db.statement.update({
          where: { id: existing.id },
          data: {
            statementDate,
            amountDue: amountDueCurrent ?? existing.amountDue,
            balance: totalDue ?? amountDueCurrent ?? existing.balance,
            amountPaid: amountPaidValue ?? existing.amountPaid,
            dueDate: ex.dueDate ? new Date(ex.dueDate) : existing.dueDate,
            chargesExcludingFees: ex.currentCharges ?? existing.chargesExcludingFees,
            penaltiesFees: ex.lateFee ?? existing.penaltiesFees,
            pastDueCarried: pastDueAmt ?? existing.pastDueCarried,
            rawDataJson: rawData as Prisma.InputJsonValue,
            pdfS3Key,
          },
        });
        updated++;
      } else {
        await db.statement.create({
          data: {
            utilityAccountId: account.id, statementDate,
            dueDate: ex.dueDate ? new Date(ex.dueDate) : null,
            billingPeriodStart: ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : null,
            billingPeriodEnd: ex.billingPeriodEnd ? new Date(ex.billingPeriodEnd) : null,
            amountDue: amountDueCurrent ?? null,
            balance: totalDue ?? amountDueCurrent ?? null,
            amountPaid: amountPaidValue,
            chargesExcludingFees: ex.currentCharges ?? null,
            penaltiesFees: ex.lateFee ?? null,
            pastDueCarried: pastDueAmt,
            usageValue: ex.usageValue ?? null, usageUnit: ex.usageUnit ?? null,
            ratePlan: ex.ratePlan ?? null, pdfS3Key, sourceType: 'MANUAL',
            rawDataJson: rawData as Prisma.InputJsonValue,
          },
        });
        imported++;
      }
    } catch (err) {
      errored++;
      console.error(`  ERROR on ${file.filePath}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\nDone. Statements — imported ${imported}, updated ${updated}, skipped ${skipped}. Personal expenses — imported ${personalImported}, skipped (already existed) ${personalSkipped}. Documents — imported ${docsImported}, skipped (already existed) ${docsSkipped}. Errors ${errored}.`);
  if (skippedFolders.size) {
    console.log(`Skipped folders (no category mapping — add them to CATEGORY_FOLDER_MAP if they should be included): ${[...skippedFolders].join(', ')}`);
  }
  if (dryRun) console.log('\nThis was a dry run — nothing was written. Re-run without --dry-run to commit.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
