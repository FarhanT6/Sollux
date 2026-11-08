-- Manager statements fetched from email: the manager's sending addresses, and where each statement came from.
ALTER TABLE "reconciliation_profiles" ADD COLUMN IF NOT EXISTS "emailFrom" TEXT;
ALTER TABLE "reconciliation_statements" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "reconciliation_statements" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT;
ALTER TABLE "reconciliation_statements" ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3);
ALTER TABLE "reconciliation_statements" ADD COLUMN IF NOT EXISTS "draftJson" JSONB;
CREATE INDEX IF NOT EXISTS "reconciliation_statements_userId_sourceRef_idx" ON "reconciliation_statements"("userId", "sourceRef");
