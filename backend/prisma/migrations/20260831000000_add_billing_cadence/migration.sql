-- Billing cadence on utility accounts, so a bill that does not arrive monthly
-- is not treated as a monthly cost, and a down-payment flag on statements so a
-- deposit is recorded without entering the monthly series.

CREATE TYPE "BillingCadence" AS ENUM (
  'MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL', 'TERM', 'ONE_TIME', 'IRREGULAR'
);

ALTER TABLE "utility_accounts"
  ADD COLUMN "billingCadence" "BillingCadence" NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN "termMonths" INTEGER,
  ADD COLUMN "expectedAmount" DECIMAL(10,2);

ALTER TABLE "statements"
  ADD COLUMN "isDownPayment" BOOLEAN NOT NULL DEFAULT false;
