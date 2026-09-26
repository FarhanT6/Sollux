-- Development projects funded from here (transfers abroad), compliance items
-- (citations, permits, inspections) with expenses linked to them, new expense
-- categories, and the tax bill's own figures on tax assessments.

ALTER TYPE "ExpenseCategory" ADD VALUE IF NOT EXISTS 'HANDYMAN';
ALTER TYPE "ExpenseCategory" ADD VALUE IF NOT EXISTS 'PERMITS';
ALTER TYPE "ExpenseCategory" ADD VALUE IF NOT EXISTS 'CITATIONS_FINES';

CREATE TABLE IF NOT EXISTS "compliance_items" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "agency" TEXT,
  "caseNumber" TEXT,
  "referenceNumber" TEXT,
  "level" TEXT,
  "issuedDate" TIMESTAMP(3),
  "violationDate" TIMESTAMP(3),
  "dueDate" TIMESTAMP(3),
  "paymentDueDate" TIMESTAMP(3),
  "fineAmount" DECIMAL(10,2),
  "apn" TEXT,
  "escalation" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "resolvedDate" TIMESTAMP(3),
  "violations" JSONB,
  "contactName" TEXT,
  "contactPhone" TEXT,
  "contactEmail" TEXT,
  "notes" TEXT,
  "documents" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "compliance_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "compliance_items_userId_status_idx" ON "compliance_items"("userId", "status");
CREATE INDEX IF NOT EXISTS "compliance_items_propertyId_idx" ON "compliance_items"("propertyId");
DO $$ BEGIN
  ALTER TABLE "compliance_items" ADD CONSTRAINT "compliance_items_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "complianceItemId" TEXT;
DO $$ BEGIN
  ALTER TABLE "expenses" ADD CONSTRAINT "expenses_complianceItemId_fkey"
    FOREIGN KEY ("complianceItemId") REFERENCES "compliance_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "development_projects" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "country" TEXT,
  "city" TEXT,
  "address" TEXT,
  "description" TEXT,
  "localCurrency" TEXT NOT NULL DEFAULT 'BDT',
  "budgetUsd" DECIMAL(14,2),
  "budgetLocal" DECIMAL(16,2),
  "floors" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "startDate" TIMESTAMP(3),
  "targetDate" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "development_projects_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "development_projects_userId_idx" ON "development_projects"("userId");

CREATE TABLE IF NOT EXISTS "project_transfers" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "amountUsd" DECIMAL(12,2) NOT NULL,
  "feeUsd" DECIMAL(10,2),
  "exchangeRate" DECIMAL(12,4),
  "amountLocal" DECIMAL(16,2),
  "method" TEXT,
  "recipient" TEXT,
  "purpose" TEXT,
  "bankAccountId" TEXT,
  "reference" TEXT,
  "notes" TEXT,
  "documentS3Key" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_transfers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "project_transfers_projectId_date_idx" ON "project_transfers"("projectId", "date");
DO $$ BEGIN
  ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "development_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "apn" TEXT;
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "taxingAuthority" TEXT;
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "installment1Amount" DECIMAL(12,2);
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "installment2Amount" DECIMAL(12,2);
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "documentS3Key" TEXT;
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "escrowLoanId" TEXT;
