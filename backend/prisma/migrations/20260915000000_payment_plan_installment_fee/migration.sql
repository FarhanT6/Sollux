-- A fee charged with each installment that does not reduce the plan balance.
ALTER TABLE "payment_plans" ADD COLUMN IF NOT EXISTS "installmentFee" DECIMAL(10,2);
