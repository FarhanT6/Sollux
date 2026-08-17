-- AlterEnum: statuses covering the life of a matter, not just open/closed
ALTER TYPE "LegalStatus" ADD VALUE 'PENDING_FILING';
ALTER TYPE "LegalStatus" ADD VALUE 'FILED';
ALTER TYPE "LegalStatus" ADD VALUE 'IN_LITIGATION';
ALTER TYPE "LegalStatus" ADD VALUE 'DISCOVERY';
ALTER TYPE "LegalStatus" ADD VALUE 'AWAITING_HEARING';
ALTER TYPE "LegalStatus" ADD VALUE 'JUDGMENT';
ALTER TYPE "LegalStatus" ADD VALUE 'APPEAL';
ALTER TYPE "LegalStatus" ADD VALUE 'SETTLED';
ALTER TYPE "LegalStatus" ADD VALUE 'DISMISSED';
ALTER TYPE "LegalStatus" ADD VALUE 'COLLECTIONS';

-- AlterEnum: document kinds a legal matter accumulates
ALTER TYPE "DocumentCategory" ADD VALUE 'CONTRACT';
ALTER TYPE "DocumentCategory" ADD VALUE 'COURT_FILING';
ALTER TYPE "DocumentCategory" ADD VALUE 'CORRESPONDENCE';

-- AlterTable: counsel, venue, opposing party, amounts, and dates that matter
ALTER TABLE "legal_matters"
  ADD COLUMN "priority"         TEXT,
  ADD COLUMN "leaseId"          TEXT,
  ADD COLUMN "attorneyFirm"     TEXT,
  ADD COLUMN "attorneyEmail"    TEXT,
  ADD COLUMN "attorneyPhone"    TEXT,
  ADD COLUMN "court"            TEXT,
  ADD COLUMN "jurisdiction"     TEXT,
  ADD COLUMN "judge"            TEXT,
  ADD COLUMN "opposingParty"    TEXT,
  ADD COLUMN "opposingCounsel"  TEXT,
  ADD COLUMN "claimAmount"      DECIMAL(12,2),
  ADD COLUMN "judgmentAmount"   DECIMAL(12,2),
  ADD COLUMN "amountCollected"  DECIMAL(12,2),
  ADD COLUMN "settlementAmount" DECIMAL(12,2),
  ADD COLUMN "nextHearingDate"  TIMESTAMP(3),
  ADD COLUMN "responseDueDate"  TIMESTAMP(3),
  ADD COLUMN "statuteDeadline"  TIMESTAMP(3),
  ADD COLUMN "outcome"          TEXT,
  ADD COLUMN "notes"            TEXT;

CREATE INDEX "legal_matters_leaseId_idx" ON "legal_matters"("leaseId");

ALTER TABLE "legal_matters" ADD CONSTRAINT "legal_matters_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: matter timeline (filings, hearings, judgments, lockouts)
CREATE TABLE "legal_events" (
    "id" TEXT NOT NULL,
    "legalMatterId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "eventType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "outcome" TEXT,
    "isCompleted" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "legal_events_legalMatterId_date_idx" ON "legal_events"("legalMatterId", "date");

ALTER TABLE "legal_events" ADD CONSTRAINT "legal_events_legalMatterId_fkey"
  FOREIGN KEY ("legalMatterId") REFERENCES "legal_matters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: attorney fees, court costs, and what has actually been paid
CREATE TABLE "legal_fees" (
    "id" TEXT NOT NULL,
    "legalMatterId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "hours" DECIMAL(8,2),
    "hourlyRate" DECIMAL(10,2),
    "payee" TEXT,
    "invoiceNumber" TEXT,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "paidDate" TIMESTAMP(3),
    "bankAccountId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_fees_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "legal_fees_legalMatterId_date_idx" ON "legal_fees"("legalMatterId", "date");
CREATE INDEX "legal_fees_bankAccountId_idx" ON "legal_fees"("bankAccountId");

ALTER TABLE "legal_fees" ADD CONSTRAINT "legal_fees_legalMatterId_fkey"
  FOREIGN KEY ("legalMatterId") REFERENCES "legal_matters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "legal_fees" ADD CONSTRAINT "legal_fees_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
