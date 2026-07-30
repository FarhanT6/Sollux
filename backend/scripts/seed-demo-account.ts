// One-off seed script for a fabricated demo/presentation account.
// Finds the User row by email (auto-created by requireAuth on first Clerk
// login) and populates it with realistic but entirely made-up data — no
// real addresses, tenants, or financial figures from the real portfolio.
//
// Usage:
//   cd backend
//   DATABASE_URL=<neon url> npx tsx scripts/seed-demo-account.ts
//
// Safe to re-run: it wipes and rebuilds only the demo user's own data
// (scoped by userId), never touches any other account.

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const DEMO_EMAIL = 'farhantalukder69@gmail.com';

async function main() {
  const user = await db.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user) {
    throw new Error(
      `No user found with email ${DEMO_EMAIL}. Log into Sollux with that account at least once first — ` +
      `the User row is auto-created on first authenticated request (see requireAuth.ts).`
    );
  }
  const userId = user.id;
  console.log(`Seeding demo data for ${DEMO_EMAIL} (userId=${userId})`);

  // Wipe this user's existing demo data so the script is safely re-runnable.
  await db.property.deleteMany({ where: { userId } }); // cascades units/leases/rentPayments/loans/utilityAccounts
  await db.loan.deleteMany({ where: { userId, propertyId: null } }); // any unattached personal loans
  await db.bankAccount.deleteMany({ where: { userId } });
  await db.otherIncome.deleteMany({ where: { userId } });

  const today = new Date();
  const monthsAgo = (n: number, day = 1) => new Date(today.getFullYear(), today.getMonth() - n, day);

  // ── Properties ────────────────────────────────────────────
  const maple = await db.property.create({
    data: {
      userId,
      nickname: 'Maple Terrace Duplex',
      address: '4210 Maple Terrace',
      city: 'Riverside',
      state: 'CA',
      zip: '92501',
      type: 'RESIDENTIAL_MULTI',
      status: 'ACTIVE',
      acquisitionDate: new Date('2021-03-15'),
      acquisitionPrice: 480000,
      estimatedValue: 610000,
    },
  });

  const harbor = await db.property.create({
    data: {
      userId,
      nickname: 'Harbor View Commercial',
      address: '118 Harbor View Blvd',
      city: 'Clearwater',
      state: 'FL',
      zip: '33755',
      type: 'COMMERCIAL',
      status: 'ACTIVE',
      acquisitionDate: new Date('2019-07-01'),
      acquisitionPrice: 950000,
      estimatedValue: 1150000,
    },
  });

  const aurora = await db.property.create({
    data: {
      userId,
      nickname: 'Aurora Fields Land',
      address: '7700 Aurora Fields Rd',
      city: 'Georgetown',
      state: 'TX',
      zip: '78626',
      type: 'LAND',
      status: 'ACTIVE',
      acquisitionDate: new Date('2023-01-10'),
      acquisitionPrice: 220000,
      estimatedValue: 265000,
    },
  });

  // ── Units, tenants, leases, rent payments ───────────────────
  const unitA = await db.unit.create({ data: { propertyId: maple.id, unitLabel: 'Unit A', bedrooms: 2, bathrooms: 1, sqft: 850 } });
  const unitB = await db.unit.create({ data: { propertyId: maple.id, unitLabel: 'Unit B', bedrooms: 2, bathrooms: 1, sqft: 850 } });
  const harborSuite = await db.unit.create({ data: { propertyId: harbor.id, unitLabel: 'Suite 100', sqft: 2400 } });

  const tenants = await Promise.all([
    db.tenant.create({ data: { userId, fullName: 'Jordan Alvarez', email: 'jordan.demo@example.com', phone: '555-010-0142' } }),
    db.tenant.create({ data: { userId, fullName: 'Priya Nair', email: 'priya.demo@example.com', phone: '555-010-0198' } }),
    db.tenant.create({ data: { userId, fullName: 'Coastal Coffee Co.', email: 'billing.demo@example.com', phone: '555-010-0233' } }),
  ]);

  const leaseA = await db.lease.create({
    data: {
      unitId: unitA.id, startDate: new Date('2024-06-01'), rentAmount: 1850,
      leaseType: 'FIXED_TERM', status: 'ACTIVE',
      leaseTenants: { create: { tenantId: tenants[0].id, isPrimary: true } },
    },
  });
  const leaseB = await db.lease.create({
    data: {
      unitId: unitB.id, startDate: new Date('2023-11-01'), rentAmount: 1750,
      leaseType: 'MONTH_TO_MONTH', status: 'ACTIVE', arrearsBalance: 875,
      leaseTenants: { create: { tenantId: tenants[1].id, isPrimary: true } },
    },
  });
  const leaseHarbor = await db.lease.create({
    data: {
      unitId: harborSuite.id, startDate: new Date('2022-01-01'), rentAmount: 4200,
      leaseType: 'FIXED_TERM', status: 'ACTIVE',
      leaseTenants: { create: { tenantId: tenants[2].id, isPrimary: true } },
    },
  });

  // Last 4 months of rent payments — mostly paid, one partial to show delinquency.
  for (let i = 3; i >= 0; i--) {
    const periodDate = monthsAgo(i);
    await db.rentPayment.create({ data: { leaseId: leaseA.id, periodDate, amount: 1850, paidDate: monthsAgo(i, 3), method: 'ACH' } });
    await db.rentPayment.create({ data: { leaseId: leaseHarbor.id, periodDate, amount: 4200, paidDate: monthsAgo(i, 1), method: 'ACH' } });
    if (i > 0) {
      await db.rentPayment.create({ data: { leaseId: leaseB.id, periodDate, amount: 1750, paidDate: monthsAgo(i, 5), method: 'ZELLE' } });
    } else {
      // current month: partial payment, leaving the arrears balance set above
      await db.rentPayment.create({ data: { leaseId: leaseB.id, periodDate, amount: 875, paidDate: monthsAgo(i, 5), method: 'ZELLE', notes: 'Partial — remainder promised next cycle' } });
    }
  }

  // ── Loans ────────────────────────────────────────────────
  // 1. Ordinary amortizing mortgage on Maple Terrace.
  await db.loan.create({
    data: {
      userId, propertyId: maple.id, loanType: 'MORTGAGE', lender: 'Riverside Community Bank',
      originalAmount: 380000, interestRate: 6.25,
      originationDate: new Date('2021-04-01'), maturityDate: new Date('2051-04-01'),
      monthlyPayment: 2340.15, currentBalance: 352600, dueDay: 1, gracePeriodDays: 15,
      paymentType: 'PRINCIPAL_AND_INTEREST', isActive: true,
    },
  });

  // 2. Interest-only balloon note on Harbor View — showcases the negative-am/balloon feature.
  await db.loan.create({
    data: {
      userId, propertyId: harbor.id, loanType: 'COMMERCIAL', lender: 'Gulfstream Capital Partners',
      originalAmount: 600000, interestRate: 7.5,
      originationDate: new Date('2022-09-01'), maturityDate: new Date('2027-09-01'),
      monthlyPayment: 3750, currentBalance: 600000, dueDay: 1, gracePeriodDays: 10,
      paymentType: 'INTEREST_ONLY', balloonPaymentAmount: 600000,
      notes: '5-year interest-only term. Balloon due at maturity for the full principal.',
      isActive: true,
    },
  });

  // ── Utility accounts ─────────────────────────────────────
  await db.utilityAccount.create({
    data: { propertyId: maple.id, providerName: 'Riverside Public Utilities', providerSlug: 'riverside-public-utilities', category: 'ELECTRIC', accountNumber: '4821', isActive: true },
  });
  await db.utilityAccount.create({
    data: { propertyId: harbor.id, providerName: 'Duke Energy', providerSlug: 'duke-energy', category: 'ELECTRIC', accountNumber: '7790', isActive: true },
  });

  // ── Bank accounts ────────────────────────────────────────
  const checking = await db.bankAccount.create({ data: { userId, name: 'Demo Operating Checking', bank: 'Chase', last4: '4471', accountType: 'CHECKING' } });
  const cash = await db.bankAccount.create({ data: { userId, name: 'Cash / Venmo', accountType: 'CASH_POOL' } });
  await db.bankBalance.create({ data: { bankAccountId: checking.id, balance: 48250.32, asOfDate: today, source: 'manual' } });
  await db.bankBalance.create({ data: { bankAccountId: cash.id, balance: 1120, asOfDate: today, source: 'manual' } });

  // ── Other income ─────────────────────────────────────────
  await db.otherIncome.create({
    data: { userId, category: 'LAUNDRY', description: 'Shared laundry machines — Maple Terrace', amount: 140, receivedDate: monthsAgo(0, 5), method: 'Cash', isRecurring: true },
  });

  console.log('Demo account seeded: 3 properties, 3 leases, 2 loans, 2 utility accounts, 2 bank accounts, 1 other-income entry.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
