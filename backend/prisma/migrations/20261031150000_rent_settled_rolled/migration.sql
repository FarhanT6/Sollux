-- A payment toward a month already rolled into arrears counts as that month's rent and comes off the balance.
ALTER TABLE "rent_payments" ADD COLUMN IF NOT EXISTS "settledRolledRent" DECIMAL(10,2) NOT NULL DEFAULT 0;
