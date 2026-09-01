/**
 * Finds statements filed under the wrong account.
 *
 * The importer used to match a bill to "the only account with this provider"
 * even when the bill named a service address belonging to a different
 * property. Combined with same-month deduplication, that overwrote one
 * property's history with another's. The matcher no longer does this, but
 * statements written while it did are still in place, and they look
 * plausible: right provider, right months, wrong meter.
 *
 * Each import records what it read off the bill in rawDataJson, so the
 * evidence is already stored. This compares the service address and account
 * number on each statement against the property and account it was filed
 * under, and reports the disagreements.
 *
 * Usage, from backend/:
 *   npx tsx scripts/audit-statement-placement.ts                 # whole portfolio
 *   npx tsx scripts/audit-statement-placement.ts "600 N"         # one property
 *
 * Read-only. It reports; moving or deleting anything is your call.
 */
import 'dotenv/config';
import { db } from '../src/config/db';
import { decryptOptional } from '../src/crypto/encrypt';

const QUERY = process.argv[2];

/** Street number plus first street word — enough to tell addresses apart. */
function addressKey(address: string): string {
  const cleaned = address.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(' ');
  const number = parts.find(p => /^\d+$/.test(p));
  const word = parts.find(p => /^[a-z]{2,}$/.test(p) && !['n','s','e','w','the'].includes(p));
  return [number, word].filter(Boolean).join(' ');
}

const digits = (s: string) => s.replace(/\D/g, '');

(async () => {
  const properties = await db.property.findMany({
    where: QUERY ? {
      OR: [
        { address: { contains: QUERY, mode: 'insensitive' } },
        { nickname: { contains: QUERY, mode: 'insensitive' } },
      ],
    } : {},
    select: { id: true, address: true, nickname: true },
  });

  let suspect = 0, checked = 0;

  for (const property of properties) {
    const key = addressKey(property.address);

    const accounts = await db.utilityAccount.findMany({
      where: { propertyId: property.id },
      select: { id: true, providerName: true, category: true, accountNumberEnc: true },
    });

    for (const account of accounts) {
      let storedNumber: string | null = null;
      try { storedNumber = digits(decryptOptional(account.accountNumberEnc) ?? ''); } catch { /* ignore */ }

      const statements = await db.statement.findMany({
        where: { utilityAccountId: account.id },
        select: { id: true, statementDate: true, amountDue: true, rawDataJson: true },
        orderBy: { statementDate: 'desc' },
      });

      const problems: string[] = [];
      for (const s of statements) {
        checked++;
        const raw = s.rawDataJson as Record<string, unknown> | null;
        if (!raw) continue;

        const serviceAddress = typeof raw.serviceAddress === 'string' ? raw.serviceAddress : null;
        const billNumber = typeof raw.accountNumber === 'string' ? digits(raw.accountNumber) : null;

        const addressDisagrees = serviceAddress != null && addressKey(serviceAddress) !== '' &&
          addressKey(serviceAddress) !== key;
        // Only compare numbers long enough to identify an account, and only
        // when both sides have one.
        const numberDisagrees = !!storedNumber && !!billNumber &&
          storedNumber.length >= 6 && billNumber.length >= 6 &&
          !storedNumber.includes(billNumber) && !billNumber.includes(storedNumber);

        if (addressDisagrees || numberDisagrees) {
          suspect++;
          problems.push(
            `    ${s.statementDate.toISOString().slice(0, 10)}  ` +
            `${s.amountDue != null ? '$' + Number(s.amountDue).toFixed(2) : '—'}  ` +
            (addressDisagrees ? `bill says "${serviceAddress}"  ` : '') +
            (numberDisagrees ? `bill acct #${billNumber}  ` : '') +
            `id ${s.id}`
          );
        }
      }

      if (problems.length) {
        console.log(`\n${property.nickname || property.address} · ${account.providerName} [${account.category}]`);
        // Print what is being compared against. Without it a reader cannot
        // tell whether the bills are misfiled or the property is simply
        // recorded under a different address — and every bill for a property
        // whose address field says something else flags, which looks alarming
        // and means nothing.
        console.log(`  property address on file: "${property.address}"`);
        console.log(`  account ${account.id}${storedNumber ? `  stored acct #${storedNumber}` : '  no acct# stored'}`);
        console.log(`  ${problems.length} of ${statements.length} statement(s) disagree with this property:`);
        problems.forEach(p => console.log(p));

        // When every statement names the same address, the property record is
        // the likelier culprit: forty bills agreeing with each other and
        // disagreeing with one field is evidence about the field.
        const addresses = new Set(
          statements
            .map(s => (s.rawDataJson as Record<string, unknown> | null)?.serviceAddress)
            .filter((a): a is string => typeof a === 'string')
        );
        if (problems.length === statements.length && addresses.size === 1) {
          console.log(`  → every bill here says "${[...addresses][0]}". If that is this property,`);
          console.log('    correct its address rather than moving the statements.');
        }
      }
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${checked} statement(s) checked, ${suspect} filed against a property the bill does not name.`);
  if (suspect > 0) {
    console.log('\nThese were written by the old matcher. Each carries its own PDF, so the');
    console.log('bill itself is the arbiter — open one before moving or deleting it.');
    console.log('Re-importing the correct PDFs over a month fixes it in place; a statement');
    console.log('belonging to a property you have not created yet has nowhere to go until');
    console.log('that account exists.');
  }

  await db.$disconnect();
})().catch(async e => {
  console.error('Failed:', e.message);
  await db.$disconnect();
  process.exit(1);
});
