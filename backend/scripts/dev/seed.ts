/**
 * A realistic sample portfolio for the local dev stack (screen tests at
 * phone size, demos). Wipes and refills the database DATABASE_URL points at,
 * so it refuses anything that is not a local database.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/… npx tsx scripts/dev/seed.ts
 */
import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL ?? '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('seed.ts only runs against a local database (DATABASE_URL must point at localhost).');
  process.exit(1);
}
const db = new PrismaClient();

const DAY = 86400000;
const now = new Date();
const daysFromNow = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n));
const monthStart = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));

async function wipe() {
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`);
  if (tables.length) await db.$executeRawUnsafe(`TRUNCATE ${tables.map(t => `"${t.tablename}"`).join(', ')} CASCADE`);
}

async function main() {
  await wipe();
  const user = await db.user.create({ data: { clerkUserId: 'user_mock', email: 'owner@example.com', fullName: 'Farhan Talukder' } });
  const userId = user.id;

  // ── Properties ────────────────────────────────────────────
  const hunsaker = await db.property.create({ data: { userId, nickname: '1536 Hunsaker St', address: '1536 Hunsaker St', city: 'Oceanside', state: 'CA', zip: '92054', type: 'RESIDENTIAL_MULTI', estimatedValue: 1850000, acquisitionPrice: 1200000, acquisitionDate: new Date('2019-06-01') } });
  const coast = await db.property.create({ data: { userId, nickname: '1015 S Coast Hwy', address: '1015 S Coast Hwy', city: 'Oceanside', state: 'CA', zip: '92054', type: 'MIXED_USE', estimatedValue: 1553000 } });
  const vista = await db.property.create({ data: { userId, nickname: 'Vista Verde', address: '4349 Vista Verde Way', city: 'Oceanside', state: 'CA', zip: '92057', type: 'PRIMARY', estimatedValue: 1100000 } });

  // ── Utility accounts, statements, payments ────────────────
  const accounts = [
    { p: hunsaker, providerName: 'SDG&E', providerSlug: 'sdge', category: 'ELECTRIC', amounts: [444.26, 464.27, 398.12], dueIn: 6 },
    { p: hunsaker, providerName: 'City of Oceanside', providerSlug: 'oceanside', category: 'WATER', amounts: [195.05, 231.22, 210.4], dueIn: 12 },
    { p: hunsaker, providerName: 'Waste Management', providerSlug: 'wm', category: 'TRASH', amounts: [124.73, 124.73, 124.73], dueIn: -9 },
    { p: coast, providerName: 'SDG&E', providerSlug: 'sdge', category: 'ELECTRIC', amounts: [612.4, 580.9, 701.3], dueIn: 3 },
    { p: coast, providerName: 'Cox Business', providerSlug: 'cox', category: 'INTERNET', amounts: [189.99, 189.99, 189.99], dueIn: 18 },
    { p: vista, providerName: 'SoCal Gas', providerSlug: 'socalgas', category: 'GAS', amounts: [58.21, 41.9, 37.15], dueIn: 21 },
    { p: vista, providerName: 'Vista Irrigation District', providerSlug: 'vid', category: 'WATER', amounts: [142.6, 151.02, 160.77], dueIn: 9 },
  ] as const;
  const acctIds: Record<string, string> = {};
  for (const a of accounts) {
    const acct = await db.utilityAccount.create({ data: { propertyId: a.p.id, providerName: a.providerName, providerSlug: a.providerSlug, category: a.category as any, accountNumber: String(1000 + Math.floor(Math.random() * 8999)), billingCadence: 'MONTHLY', isActive: true } });
    acctIds[`${a.p.nickname}:${a.category}`] = acct.id;
    for (let i = 0; i < a.amounts.length; i++) {
      const due = daysFromNow(a.dueIn - 30 * i);
      const st = await db.statement.create({ data: {
        utilityAccountId: acct.id, statementDate: new Date(due.getTime() - 21 * DAY), dueDate: due,
        billingPeriodStart: new Date(due.getTime() - 51 * DAY), billingPeriodEnd: new Date(due.getTime() - 21 * DAY),
        amountDue: a.amounts[i], sourceType: 'MANUAL',
      } });
      // Older bills paid; the newest open (WM's is past due).
      if (i > 0) await db.payment.create({ data: { utilityAccountId: acct.id, statementId: st.id, amount: a.amounts[i], paymentDate: new Date(due.getTime() - 3 * DAY) } });
    }
  }

  // ── Units, tenants, leases, rent ──────────────────────────
  const tenants = async (names: string[]) => Promise.all(names.map(fullName => db.tenant.create({ data: { userId, fullName } })));
  const lease = async (propertyId: string, unitLabel: string, names: string[], rent: number, extra: Record<string, unknown> = {}) => {
    const unit = await db.unit.create({ data: { propertyId, unitLabel } });
    const ts = await tenants(names);
    return db.lease.create({ data: {
      unitId: unit.id, rentAmount: rent, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', rentDueDay: 1,
      startDate: new Date('2025-05-01'), securityDeposit: rent, arrearsCaughtUpThrough: monthStart(-1),
      leaseTenants: { create: ts.map((t, i) => ({ tenantId: t.id, isPrimary: i === 0 })) }, ...extra,
    } });
  };
  const main1 = await lease(hunsaker.id, 'Main', ['Jacob Adams', 'Nikola Radovanovic'], 4452);
  const pond = await lease(hunsaker.id, 'Pond', ['Matthew Connolly'], 1950, { arrearsBalance: 3800 });
  const shed = await lease(hunsaker.id, 'Shed', ['Cassandra California'], 1600);
  await lease(hunsaker.id, 'Studio', ['Adam Taylor'], 1400);
  const front = await lease(coast.id, 'Front Unit', ['Sergio Salazar'], 2900, { businessName: 'Mariposa Nails and Spa', leaseType: 'FIXED_TERM', startDate: new Date('2026-09-01'), endDate: new Date('2027-08-31') });
  await db.leaseUtilityCharge.createMany({ data: [{ leaseId: front.id, category: 'WATER', amount: 50 }, { leaseId: front.id, category: 'TRASH', amount: 50 }] });
  const pay = (leaseId: string, amount: number, offsetDays: number, method = 'ZELLE') =>
    db.rentPayment.create({ data: { leaseId, amount, paidDate: daysFromNow(offsetDays), periodDate: monthStart(0), method: method as any } });
  await pay(main1.id, 4452, -12);
  await pay(shed.id, 1600, -14);
  await pay(pond.id, 400, -7, 'CASH');
  await pay(front.id, 2900, -15);

  // ── Insights, a shut-off notice ───────────────────────────
  await db.aIInsight.createMany({ data: [
    { propertyId: hunsaker.id, insightType: 'ANOMALY', severity: 'WARNING', title: 'SDG&E bill up 23% at 1536 Hunsaker St', body: 'September usage was 23% above the same month last year.' },
    { propertyId: hunsaker.id, insightType: 'REMINDER', severity: 'ALERT', title: 'Waste Management is past due', body: 'Service interruption notice received. $124.73 is past due.' },
    { propertyId: vista.id, insightType: 'SAVINGS', severity: 'INFO', title: 'Switch SoCal Gas to autopay', body: 'Autopay avoids the late fee charged twice this year.' },
  ] });
  await db.serviceNotice.create({ data: { userId, utilityAccountId: acctIds['1536 Hunsaker St:TRASH'], kind: 'DISCONNECTION', provider: 'Waste Management', accountLast4: '3001', noticeDate: daysFromNow(-7), amountDemanded: 124.73, summary: 'Account past due and under review for service interruption.', status: 'OPEN' } });

  // ── Money ─────────────────────────────────────────────────
  await db.bankAccount.createMany({ data: [
    { userId, name: 'Wells Fargo Checking', bank: 'Wells Fargo', last4: '0705', accountType: 'CHECKING', watchForRentPayments: true },
    { userId, name: 'Chase Business', bank: 'Chase', last4: '0935', accountType: 'CHECKING' },
  ] });
  await db.loan.create({ data: { userId, propertyId: hunsaker.id, loanType: 'MORTGAGE', lender: 'Rocket Mortgage', originalAmount: 960000, currentBalance: 842310, interestRate: 3.25, monthlyPayment: 4890, isActive: true } }).catch(e => console.warn('loan skipped:', e.message.split('\n').slice(-1)[0]));

  console.log(`Seeded owner@example.com: 3 properties, ${accounts.length} utility accounts, 5 leases.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
