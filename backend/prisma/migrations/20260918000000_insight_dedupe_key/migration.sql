-- The bookkeeper's stable key for a finding, so a nightly run refreshes the
-- one it raised before rather than raising it again.
ALTER TABLE "ai_insights" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
ALTER TABLE "ai_insights" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS "ai_insights_dedupeKey_idx" ON "ai_insights"("dedupeKey");
