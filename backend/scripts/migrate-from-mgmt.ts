// One-time data migration: copies property-management data from the old
// Mgmt (Next.js) app's Postgres database into Sollux's Postgres database.
//
// Usage:
//   MGMT_DATABASE_URL="postgresql://..." npx tsx scripts/migrate-from-mgmt.ts
//
// Reads directly from Mgmt via raw SQL (no Prisma client needed for the
// source) and writes into Sollux via the local Prisma client, preserving
// every record's original id so foreign keys carry over unchanged.
//
// Skipped on purpose: Mgmt's UtilityAccount/UtilityBill, PaymentMethod, and
// Document/SyncLog tables. Sollux tracks utilities through its own
// scraper/statement pipeline, which is a different shape — those aren't
// migrated here to avoid clobbering what Sollux already has.

import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';

const MGMT_DATABASE_URL = process.env.MGMT_DATABASE_URL;
if (!MGMT_DATABASE_URL) {
  console.error('Set MGMT_DATABASE_URL to your Mgmt Postgres connection string first.');
  process.exit(1);
}

const db = new PrismaClient();
const mgmt = new Client({ connectionString: MGMT_DATABASE_URL });

// Mgmt's PropertyType has values Sollux's enum doesn't (PRIMARY_RESIDENCE, COMMERCIAL is shared).
const PROPERTY_TYPE_MAP: Record<string, string> = {
  RESIDENTIAL_SINGLE: 'RESIDENTIAL_SINGLE',
  RESIDENTIAL_MULTI: 'RESIDENTIAL_MULTI',
  COMMERCIAL: 'COMMERCIAL',
  LAND: 'LAND',
  GOLF_COURSE: 'GOLF_COURSE',
  PRIMARY_RESIDENCE: 'PRIMARY',
  OTHER: 'OTHER',
};

async function resolveTargetUserId(): Promise<string> {
  const override = process.env.SOLLUX_USER_ID;
  if (override) return override;

  const users = await db.user.findMany({ select: { id: true, email: true, clerkUserId: true } });
  if (users.length === 0) {
    throw new Error('No users found in the Sollux database. Sign in to the app once first, then re-run this script.');
  }
  if (users.length > 1) {
    throw new Error(
      `Multiple Sollux users found — set SOLLUX_USER_ID explicitly.\n` +
      users.map(u => `  ${u.id}  ${u.email}`).join('\n')
    );
  }
  console.log(`Using Sollux user: ${users[0].email} (${users[0].id})`);
  return users[0].id;
}

async function main() {
  await mgmt.connect();
  const userId = await resolveTargetUserId();

  let counts: Record<string, number> = {};

  // ---------- Properties ----------
  const { rows: properties } = await mgmt.query('SELECT * FROM "Property"');
  for (const p of properties) {
    await db.property.upsert({
      where: { id: p.id },
      update: {},
      create: {
        id: p.id,
        userId,
        nickname: p.name,
        address: p.addressLine1,
        addressLine2: p.addressLine2,
        city: p.city,
        county: p.county,
        state: p.state,
        zip: p.zip ?? '',
        country: p.country ?? 'US',
        region: p.region,
        type: (PROPERTY_TYPE_MAP[p.propertyType] ?? 'OTHER') as any,
        status: p.status,
        acquisitionDate: p.acquisitionDate,
        acquisitionPrice: p.acquisitionPrice,
        ownerEntity: p.ownerEntity,
        notes: p.notes,
        estimatedValue: p.estimatedValue,
        landValue: p.landValue,
        valuationDate: p.valuationDate,
        valuationNotes: p.valuationNotes,
        lotSqft: p.lotSqft,
        parcelGroupName: p.parcelGroupName,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      },
    });
  }
  counts.properties = properties.length;

  // ---------- Units ----------
  const { rows: units } = await mgmt.query('SELECT * FROM "Unit"');
  for (const u of units) {
    await db.unit.upsert({
      where: { id: u.id },
      update: {},
      create: {
        id: u.id,
        propertyId: u.propertyId,
        unitLabel: u.unitLabel,
        bedrooms: u.bedrooms,
        bathrooms: u.bathrooms,
        sqft: u.sqft,
        notes: u.notes,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      },
    });
  }
  counts.units = units.length;

  // ---------- Tenants ----------
  const { rows: tenants } = await mgmt.query('SELECT * FROM "Tenant"');
  for (const t of tenants) {
    await db.tenant.upsert({
      where: { id: t.id },
      update: {},
      create: {
        id: t.id,
        userId,
        fullName: t.fullName,
        email: t.email,
        phone: t.phone,
        notes: t.notes,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      },
    });
  }
  counts.tenants = tenants.length;

  // ---------- Leases ----------
  const { rows: leases } = await mgmt.query('SELECT * FROM "Lease"');
  for (const l of leases) {
    await db.lease.upsert({
      where: { id: l.id },
      update: {},
      create: {
        id: l.id,
        unitId: l.unitId,
        startDate: l.startDate,
        endDate: l.endDate,
        rentAmount: l.rentAmount,
        section8Amount: l.section8Amount,
        securityDeposit: l.securityDeposit,
        leaseType: l.leaseType,
        status: l.status,
        documentUrl: l.documentUrl,
        notes: l.notes,
        arrearsBalance: l.arrearsBalance,
        arrearsCaughtUpThrough: l.arrearsCaughtUpThrough,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      },
    });
  }
  counts.leases = leases.length;

  // ---------- LeaseTenants ----------
  const { rows: leaseTenants } = await mgmt.query('SELECT * FROM "LeaseTenant"');
  for (const lt of leaseTenants) {
    await db.leaseTenant.upsert({
      where: { id: lt.id },
      update: {},
      create: {
        id: lt.id,
        leaseId: lt.leaseId,
        tenantId: lt.tenantId,
        isPrimary: lt.isPrimary,
      },
    });
  }
  counts.leaseTenants = leaseTenants.length;

  // ---------- RentPayments ----------
  const { rows: rentPayments } = await mgmt.query('SELECT * FROM "RentPayment"');
  for (const rp of rentPayments) {
    await db.rentPayment.upsert({
      where: { id: rp.id },
      update: {},
      create: {
        id: rp.id,
        leaseId: rp.leaseId,
        periodDate: rp.periodDate,
        amount: rp.amount,
        appliedToArrears: rp.appliedToArrears,
        paidDate: rp.paidDate,
        method: rp.method,
        notes: rp.notes,
        createdAt: rp.createdAt,
      },
    });
  }
  counts.rentPayments = rentPayments.length;

  // ---------- RentNotices ----------
  const { rows: rentNotices } = await mgmt.query('SELECT * FROM "RentNotice"');
  for (const n of rentNotices) {
    await db.rentNotice.upsert({
      where: { id: n.id },
      update: {},
      create: {
        id: n.id,
        leaseId: n.leaseId,
        noticeDate: n.noticeDate,
        lineItems: n.lineItems,
        totalDue: n.totalDue,
        signedByName: n.signedByName,
        signedByPhone: n.signedByPhone,
        signedByEmail: n.signedByEmail,
        signedByAddress: n.signedByAddress,
        createdAt: n.createdAt,
      },
    });
  }
  counts.rentNotices = rentNotices.length;

  // ---------- Expenses ----------
  const { rows: expenses } = await mgmt.query('SELECT * FROM "Expense"');
  for (const e of expenses) {
    await db.expense.upsert({
      where: { id: e.id },
      update: {},
      create: {
        id: e.id,
        propertyId: e.propertyId,
        category: e.category,
        amount: e.amount,
        date: e.date,
        vendor: e.vendor,
        description: e.description,
        isCapEx: e.isCapEx,
        isPersonal: e.isPersonal,
        documentUrl: e.documentUrl,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      },
    });
  }
  counts.expenses = expenses.length;

  // ---------- Loans ----------
  const { rows: loans } = await mgmt.query('SELECT * FROM "Loan"');
  for (const l of loans) {
    await db.loan.upsert({
      where: { id: l.id },
      update: {},
      create: {
        id: l.id,
        propertyId: l.propertyId,
        userId,
        loanType: l.loanType,
        lender: l.lender,
        accountLast4: l.accountLast4,
        originalAmount: l.originalAmount,
        interestRate: l.interestRate,
        originationDate: l.originationDate,
        maturityDate: l.maturityDate,
        monthlyPayment: l.monthlyPayment,
        currentBalance: l.currentBalance,
        notes: l.notes,
        isPersonal: l.isPersonal,
        isActive: l.isActive,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      },
    });
  }
  counts.loans = loans.length;

  // ---------- LoanPayments ----------
  const { rows: loanPayments } = await mgmt.query('SELECT * FROM "LoanPayment"');
  for (const lp of loanPayments) {
    await db.loanPayment.upsert({
      where: { id: lp.id },
      update: {},
      create: {
        id: lp.id,
        loanId: lp.loanId,
        date: lp.date,
        billAmount: lp.billAmount,
        amount: lp.amount,
        lateFee: lp.lateFee,
        status: lp.status,
        principal: lp.principal,
        interest: lp.interest,
        escrow: lp.escrow,
        balanceAfter: lp.balanceAfter,
        confirmationNumber: lp.confirmationNumber,
        notes: lp.notes,
      },
    });
  }
  counts.loanPayments = loanPayments.length;

  // ---------- Insurance Policies ----------
  const { rows: policies } = await mgmt.query('SELECT * FROM "InsurancePolicy"');
  for (const ip of policies) {
    await db.insurancePolicy.upsert({
      where: { id: ip.id },
      update: {},
      create: {
        id: ip.id,
        propertyId: ip.propertyId,
        carrier: ip.carrier,
        policyNumber: ip.policyNumber,
        policyType: ip.policyType,
        premiumAmount: ip.premiumAmount,
        premiumFrequency: ip.premiumFrequency,
        effectiveDate: ip.effectiveDate,
        expirationDate: ip.expirationDate,
        documentUrl: ip.documentUrl,
        notes: ip.notes,
        isPersonal: ip.isPersonal,
        isActive: ip.isActive,
      },
    });
  }
  counts.insurancePolicies = policies.length;

  // ---------- Tax Assessments ----------
  const { rows: taxes } = await mgmt.query('SELECT * FROM "TaxAssessment"');
  for (const t of taxes) {
    await db.taxAssessment.upsert({
      where: { id: t.id },
      update: {},
      create: {
        id: t.id,
        propertyId: t.propertyId,
        taxYear: t.taxYear,
        assessedValue: t.assessedValue,
        annualTaxAmount: t.annualTaxAmount,
        installment1Due: t.installment1Due,
        installment2Due: t.installment2Due,
        installment1Paid: t.installment1Paid,
        installment2Paid: t.installment2Paid,
        status: t.status,
        notes: t.notes,
      },
    });
  }
  counts.taxAssessments = taxes.length;

  // ---------- Improvements ----------
  const { rows: improvements } = await mgmt.query('SELECT * FROM "Improvement"');
  for (const i of improvements) {
    await db.improvement.upsert({
      where: { id: i.id },
      update: {},
      create: {
        id: i.id,
        propertyId: i.propertyId,
        description: i.description,
        category: i.category,
        cost: i.cost,
        contractor: i.contractor,
        startDate: i.startDate,
        completionDate: i.completionDate,
        documentUrl: i.documentUrl,
        notes: i.notes,
      },
    });
  }
  counts.improvements = improvements.length;

  // ---------- Legal Matters ----------
  const { rows: legalMatters } = await mgmt.query('SELECT * FROM "LegalMatter"');
  for (const lm of legalMatters) {
    await db.legalMatter.upsert({
      where: { id: lm.id },
      update: {},
      create: {
        id: lm.id,
        propertyId: lm.propertyId,
        userId,
        title: lm.title,
        matterType: lm.matterType,
        status: lm.status,
        filedDate: lm.filedDate,
        closedDate: lm.closedDate,
        attorney: lm.attorney,
        caseNumber: lm.caseNumber,
        description: lm.description,
        documentUrl: lm.documentUrl,
        createdAt: lm.createdAt,
        updatedAt: lm.updatedAt,
      },
    });
  }
  counts.legalMatters = legalMatters.length;

  console.log('\nMigration complete:');
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
}

main()
  .catch(err => {
    console.error('\nMigration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await mgmt.end();
    await db.$disconnect();
  });
