/**
 * Standalone scraper test — run with:
 *   npx tsx src/scrapers/testScraper.ts sdge username password
 */
import 'dotenv/config';
import { getScraperProvider } from './registry';

const [,, slug, username, password, accountNumber] = process.argv;

if (!slug || !username || !password) {
  console.error('Usage: npx tsx src/scrapers/testScraper.ts <slug> <username> <password> [accountNumber]');
  console.error('Slugs: sdge, socal-gas, cox, wm, fpl');
  process.exit(1);
}

async function main() {
  console.log(`\n🔍 Testing scraper: ${slug}`);
  const scraper = getScraperProvider(slug);
  if (!scraper) {
    console.error(`No scraper found for slug: ${slug}`);
    process.exit(1);
  }

  const result = await scraper.run({ username, password, accountNumber });

  console.log('\n─── Result ─────────────────────────────────');
  console.log('Success:', result.success);
  if (result.error) console.log('Error:', result.error);
  console.log('Statements found:', result.statements.length);
  console.log('Payments found:', result.payments.length);

  if (result.statements.length > 0) {
    console.log('\n─── First statement ─────────────────────────');
    const s = result.statements[0];
    console.log('Date:', s.statementDate);
    console.log('Due:', s.dueDate);
    console.log('Amount due: $' + s.amountDue);
    console.log('Usage:', s.usageValue, s.usageUnit);
    console.log('PDF:', s.pdfBuffer ? `${s.pdfBuffer.length} bytes` : 'none');
  }

  if (result.payments.length > 0) {
    console.log('\n─── First payment ──────────────────────────');
    const p = result.payments[0];
    console.log('Date:', p.paymentDate);
    console.log('Amount: $' + p.amount);
    console.log('Confirmation:', p.confirmationNumber);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
