-- A payment logged toward the payment arrangement rather than a bill.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "towardPlan" BOOLEAN NOT NULL DEFAULT false;
