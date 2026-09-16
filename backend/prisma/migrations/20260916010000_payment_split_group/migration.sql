-- One real payment split across several bills: one row per bill, sharing this id.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "splitGroupId" TEXT;
CREATE INDEX IF NOT EXISTS "payments_splitGroupId_idx" ON "payments"("splitGroupId");
