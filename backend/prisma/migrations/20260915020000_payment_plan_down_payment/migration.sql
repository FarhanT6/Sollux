-- Paid up front when the arrangement was made.
ALTER TABLE "payment_plans" ADD COLUMN IF NOT EXISTS "downPayment" DECIMAL(10,2);
