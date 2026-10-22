-- The fees logged with a payment, by kind (late fee, contamination,
-- delinquent charge, …), so each goes on the bill as its own line.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "feesAddedJson" JSONB;
