-- Property tax in full: the parcel number on the property, the roll's values
-- and the bill's special assessments and delinquency dates on each year, and
-- the years left unpaid (California defaults, Florida certificates).
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "apn" TEXT;

ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "installment1Delinquent" TIMESTAMP(3);
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "installment2Delinquent" TIMESTAMP(3);
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "billNumber" TEXT;
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "landValue" DECIMAL(14,2);
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "improvementValue" DECIMAL(14,2);
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "marketValue" DECIMAL(14,2);
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "exemptionsValue" DECIMAL(14,2);
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "exemptionsNote" TEXT;
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "baseYear" TEXT;
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "taxRate" DECIMAL(8,5);
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "specialAssessmentsJson" JSONB;
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "penaltiesOwed" DECIMAL(12,2);
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "balanceOwed" DECIMAL(12,2);
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "sourceUrl" TEXT;
ALTER TABLE "tax_assessments" ADD COLUMN IF NOT EXISTS "lookedUpAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "tax_defaults" (
  "id" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "taxYear" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "defaultNumber" TEXT,
  "defaultDate" TIMESTAMP(3),
  "taxAmount" DECIMAL(12,2),
  "penalties" DECIMAL(12,2),
  "costs" DECIMAL(12,2),
  "amountToRedeem" DECIMAL(12,2),
  "redeemGoodThrough" TIMESTAMP(3),
  "powerToSellDate" TIMESTAMP(3),
  "payPlanJson" JSONB,
  "certificateNumber" TEXT,
  "certificateHolder" TEXT,
  "certificateRate" DECIMAL(6,3),
  "certificateIssued" TIMESTAMP(3),
  "redeemedOn" TIMESTAMP(3),
  "notes" TEXT,
  "sourceUrl" TEXT,
  "lookedUpAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tax_defaults_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tax_defaults_propertyId_taxYear_key" ON "tax_defaults"("propertyId", "taxYear");
DO $$ BEGIN
  ALTER TABLE "tax_defaults" ADD CONSTRAINT "tax_defaults_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The parcel number already on a tax record goes on its property.
UPDATE "properties" p SET "apn" = t."apn"
FROM (SELECT DISTINCT ON ("propertyId") "propertyId", "apn" FROM "tax_assessments" WHERE "apn" IS NOT NULL AND "apn" <> '' ORDER BY "propertyId", "taxYear" DESC) t
WHERE p."id" = t."propertyId" AND p."apn" IS NULL;
