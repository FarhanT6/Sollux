-- The month a loan payment covers, and how it was paid.
ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "periodDate" TIMESTAMP(3);
ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "method" TEXT;
