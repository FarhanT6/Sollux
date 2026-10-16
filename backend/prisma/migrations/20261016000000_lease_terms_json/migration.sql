-- The lease summary read from the agreement: landlord and pay-to, guarantors,
-- use, insurance, maintenance, utilities, renewal, move-in costs, other terms.
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "termsJson" JSONB;
