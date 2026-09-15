-- How much of a payment was taken off the account's payment plan.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "planApplied" DECIMAL(10,2);
