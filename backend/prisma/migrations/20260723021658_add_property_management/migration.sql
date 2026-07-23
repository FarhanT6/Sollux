/*
  Warnings:

  - A unique constraint covering the columns `[email]` on the table `gmail_tokens` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,email]` on the table `gmail_tokens` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "PropertyStatus" AS ENUM ('ACTIVE', 'SOLD', 'UNDER_CONTRACT', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PaymentPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeaseType" AS ENUM ('FIXED_TERM', 'MONTH_TO_MONTH');

-- CreateEnum
CREATE TYPE "LeaseStatus" AS ENUM ('ACTIVE', 'ENDED', 'PENDING', 'TERMINATED');

-- CreateEnum
CREATE TYPE "RentPaymentMethod" AS ENUM ('CASH', 'CHECK', 'ZELLE', 'ACH', 'MONEY_ORDER', 'CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('UTILITIES', 'REPAIRS_MAINTENANCE', 'LANDSCAPING', 'PROPERTY_MANAGEMENT', 'LEGAL', 'INSURANCE', 'PROPERTY_TAX', 'HOA', 'MORTGAGE_DEBT_SERVICE', 'CAPITAL_IMPROVEMENT', 'SUPPLIES', 'TRAVEL', 'ADVERTISING', 'OTHER');

-- CreateEnum
CREATE TYPE "LoanType" AS ENUM ('MORTGAGE', 'HELOC', 'AUTO', 'PERSONAL', 'STUDENT', 'INSTALLMENT_PLAN', 'CREDIT_LINE', 'OTHER');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('UNPAID', 'PAID', 'ON_PAYMENT_PLAN', 'PAST_DUE');

-- CreateEnum
CREATE TYPE "InsuranceType" AS ENUM ('PROPERTY', 'LIABILITY', 'FLOOD', 'UMBRELLA', 'OTHER');

-- CreateEnum
CREATE TYPE "PremiumFrequency" AS ENUM ('MONTHLY', 'ANNUAL', 'SEMI_ANNUAL');

-- CreateEnum
CREATE TYPE "TaxStatus" AS ENUM ('UNPAID', 'PAID', 'PARTIALLY_PAID', 'DELINQUENT');

-- CreateEnum
CREATE TYPE "LegalStatus" AS ENUM ('OPEN', 'CLOSED', 'ON_HOLD');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PropertyType" ADD VALUE 'RESIDENTIAL_SINGLE';
ALTER TYPE "PropertyType" ADD VALUE 'RESIDENTIAL_MULTI';
ALTER TYPE "PropertyType" ADD VALUE 'LAND';
ALTER TYPE "PropertyType" ADD VALUE 'GOLF_COURSE';
ALTER TYPE "PropertyType" ADD VALUE 'OTHER';

-- DropIndex
DROP INDEX "gmail_tokens_userId_key";

-- AlterTable
ALTER TABLE "gmail_tokens" ADD COLUMN     "label" TEXT;

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "acquisitionDate" TIMESTAMP(3),
ADD COLUMN     "acquisitionPrice" DECIMAL(14,2),
ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "county" TEXT,
ADD COLUMN     "estimatedValue" DECIMAL(14,2),
ADD COLUMN     "landValue" DECIMAL(14,2),
ADD COLUMN     "lotSqft" INTEGER,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "ownerEntity" TEXT,
ADD COLUMN     "parcelGroupName" TEXT,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "status" "PropertyStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "valuationDate" TIMESTAMP(3),
ADD COLUMN     "valuationNotes" TEXT;

-- AlterTable
ALTER TABLE "utility_accounts" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "payment_plans" (
    "id" TEXT NOT NULL,
    "utilityAccountId" TEXT NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "remainingBalance" DECIMAL(10,2) NOT NULL,
    "monthlyAmount" DECIMAL(10,2) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "description" TEXT,
    "status" "PaymentPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_recipients" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,

    CONSTRAINT "payment_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "unitLabel" TEXT NOT NULL,
    "bedrooms" DOUBLE PRECISION,
    "bathrooms" DOUBLE PRECISION,
    "sqft" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lease_tenants" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "lease_tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leases" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "rentAmount" DECIMAL(10,2) NOT NULL,
    "section8Amount" DECIMAL(10,2),
    "securityDeposit" DECIMAL(10,2),
    "leaseType" "LeaseType" NOT NULL DEFAULT 'MONTH_TO_MONTH',
    "status" "LeaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "documentUrl" TEXT,
    "notes" TEXT,
    "arrearsBalance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "arrearsCaughtUpThrough" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rent_payments" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "periodDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "appliedToArrears" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paidDate" TIMESTAMP(3) NOT NULL,
    "method" "RentPaymentMethod" NOT NULL DEFAULT 'OTHER',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rent_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rent_notices" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "noticeDate" TIMESTAMP(3) NOT NULL,
    "lineItems" JSONB NOT NULL,
    "totalDue" DECIMAL(10,2) NOT NULL,
    "signedByName" TEXT NOT NULL,
    "signedByPhone" TEXT,
    "signedByEmail" TEXT,
    "signedByAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rent_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "vendor" TEXT,
    "description" TEXT,
    "isCapEx" BOOLEAN NOT NULL DEFAULT false,
    "isPersonal" BOOLEAN NOT NULL DEFAULT false,
    "documentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT,
    "userId" TEXT NOT NULL,
    "loanType" "LoanType" NOT NULL,
    "lender" TEXT NOT NULL,
    "accountLast4" TEXT,
    "originalAmount" DECIMAL(14,2),
    "interestRate" DECIMAL(6,3),
    "originationDate" TIMESTAMP(3),
    "maturityDate" TIMESTAMP(3),
    "monthlyPayment" DECIMAL(10,2),
    "currentBalance" DECIMAL(14,2),
    "notes" TEXT,
    "isPersonal" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_payments" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "billAmount" DECIMAL(10,2),
    "amount" DECIMAL(10,2) NOT NULL,
    "lateFee" DECIMAL(10,2),
    "status" "BillStatus" NOT NULL DEFAULT 'PAID',
    "principal" DECIMAL(10,2),
    "interest" DECIMAL(10,2),
    "escrow" DECIMAL(10,2),
    "balanceAfter" DECIMAL(14,2),
    "confirmationNumber" TEXT,
    "notes" TEXT,

    CONSTRAINT "loan_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_policies" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "policyNumber" TEXT,
    "policyType" "InsuranceType" NOT NULL DEFAULT 'PROPERTY',
    "premiumAmount" DECIMAL(10,2) NOT NULL,
    "premiumFrequency" "PremiumFrequency" NOT NULL DEFAULT 'ANNUAL',
    "effectiveDate" TIMESTAMP(3),
    "expirationDate" TIMESTAMP(3),
    "documentUrl" TEXT,
    "notes" TEXT,
    "isPersonal" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "insurance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_assessments" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "taxYear" TEXT NOT NULL,
    "assessedValue" DECIMAL(14,2),
    "annualTaxAmount" DECIMAL(12,2) NOT NULL,
    "installment1Due" TIMESTAMP(3),
    "installment2Due" TIMESTAMP(3),
    "installment1Paid" TIMESTAMP(3),
    "installment2Paid" TIMESTAMP(3),
    "status" "TaxStatus" NOT NULL DEFAULT 'UNPAID',
    "notes" TEXT,

    CONSTRAINT "tax_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "improvements" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "cost" DECIMAL(12,2) NOT NULL,
    "contractor" TEXT,
    "startDate" TIMESTAMP(3),
    "completionDate" TIMESTAMP(3),
    "documentUrl" TEXT,
    "notes" TEXT,

    CONSTRAINT "improvements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_matters" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "matterType" TEXT NOT NULL,
    "status" "LegalStatus" NOT NULL DEFAULT 'OPEN',
    "filedDate" TIMESTAMP(3),
    "closedDate" TIMESTAMP(3),
    "attorney" TEXT,
    "caseNumber" TEXT,
    "description" TEXT,
    "documentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_matters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_plans_utilityAccountId_key" ON "payment_plans"("utilityAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_recipients_userId_key" ON "payment_recipients"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "units_propertyId_unitLabel_key" ON "units"("propertyId", "unitLabel");

-- CreateIndex
CREATE INDEX "tenants_userId_idx" ON "tenants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "lease_tenants_leaseId_tenantId_key" ON "lease_tenants"("leaseId", "tenantId");

-- CreateIndex
CREATE INDEX "rent_payments_leaseId_periodDate_idx" ON "rent_payments"("leaseId", "periodDate");

-- CreateIndex
CREATE INDEX "rent_notices_leaseId_idx" ON "rent_notices"("leaseId");

-- CreateIndex
CREATE INDEX "expenses_propertyId_date_idx" ON "expenses"("propertyId", "date");

-- CreateIndex
CREATE INDEX "loans_propertyId_idx" ON "loans"("propertyId");

-- CreateIndex
CREATE INDEX "loans_userId_idx" ON "loans"("userId");

-- CreateIndex
CREATE INDEX "loan_payments_loanId_date_idx" ON "loan_payments"("loanId", "date");

-- CreateIndex
CREATE INDEX "insurance_policies_propertyId_idx" ON "insurance_policies"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "tax_assessments_propertyId_taxYear_key" ON "tax_assessments"("propertyId", "taxYear");

-- CreateIndex
CREATE INDEX "improvements_propertyId_idx" ON "improvements"("propertyId");

-- CreateIndex
CREATE INDEX "legal_matters_propertyId_idx" ON "legal_matters"("propertyId");

-- CreateIndex
CREATE INDEX "legal_matters_userId_idx" ON "legal_matters"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "gmail_tokens_email_key" ON "gmail_tokens"("email");

-- CreateIndex
CREATE UNIQUE INDEX "gmail_tokens_userId_email_key" ON "gmail_tokens"("userId", "email");

-- CreateIndex
CREATE INDEX "properties_userId_state_idx" ON "properties"("userId", "state");

-- AddForeignKey
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_utilityAccountId_fkey" FOREIGN KEY ("utilityAccountId") REFERENCES "utility_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_recipients" ADD CONSTRAINT "payment_recipients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lease_tenants" ADD CONSTRAINT "lease_tenants_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lease_tenants" ADD CONSTRAINT "lease_tenants_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leases" ADD CONSTRAINT "leases_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rent_payments" ADD CONSTRAINT "rent_payments_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rent_notices" ADD CONSTRAINT "rent_notices_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_assessments" ADD CONSTRAINT "tax_assessments_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "improvements" ADD CONSTRAINT "improvements_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_matters" ADD CONSTRAINT "legal_matters_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
