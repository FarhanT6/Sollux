-- Net-metering (solar) accounts: charges deferred to the annual true-up.
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "trueUpDeferred" DECIMAL(10,2);
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "trueUpBalance" DECIMAL(10,2);
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "trueUpDate" TIMESTAMP(3);
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "hasTrueUp" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "trueUpDate" TIMESTAMP(3);
