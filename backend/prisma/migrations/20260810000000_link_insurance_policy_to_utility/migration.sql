ALTER TABLE "insurance_policies" ADD COLUMN "utilityAccountId" TEXT;

CREATE UNIQUE INDEX "insurance_policies_utilityAccountId_key" ON "insurance_policies"("utilityAccountId");

ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_utilityAccountId_fkey"
  FOREIGN KEY ("utilityAccountId") REFERENCES "utility_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: link every pre-existing INSURANCE-category utility account to a
-- new InsurancePolicy row (carrier = provider name, isActive mirrored, $0
-- placeholder premium to be filled in under Portfolio → Insurance), so
-- accounts added before this feature existed show up there too. Idempotent —
-- only inserts where a link doesn't already exist.
INSERT INTO "insurance_policies" (id, "propertyId", "utilityAccountId", carrier, "premiumAmount", "premiumFrequency", "policyType", "isPersonal", "isActive")
SELECT gen_random_uuid()::text, ua."propertyId", ua.id, ua."providerName", 0, 'ANNUAL', 'PROPERTY', false, ua."isActive"
FROM "utility_accounts" ua
WHERE ua.category = 'INSURANCE'
  AND NOT EXISTS (SELECT 1 FROM "insurance_policies" ip WHERE ip."utilityAccountId" = ua.id);
