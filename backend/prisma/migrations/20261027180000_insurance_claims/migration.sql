-- Insurance claims: the loss, its status, payments and the adjuster.
CREATE TABLE IF NOT EXISTS "insurance_claims" (
  "id" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "policyId" TEXT,
  "claimNumber" TEXT,
  "dateOfLoss" TIMESTAMP(3),
  "reportedOn" TIMESTAMP(3),
  "cause" TEXT NOT NULL DEFAULT 'OTHER',
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "amountClaimed" DECIMAL(12,2),
  "amountPaid" DECIMAL(12,2),
  "deductibleApplied" DECIMAL(12,2),
  "adjusterName" TEXT,
  "adjusterPhone" TEXT,
  "adjusterEmail" TEXT,
  "nextStep" TEXT,
  "nextStepDate" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "insurance_claims_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "insurance_claims_propertyId_idx" ON "insurance_claims"("propertyId");
DO $$ BEGIN
  ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
