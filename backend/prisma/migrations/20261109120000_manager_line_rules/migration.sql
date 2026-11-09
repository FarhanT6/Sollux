-- What the owner chose for each kind of manager-statement line, remembered per manager.
ALTER TABLE "reconciliation_profiles" ADD COLUMN IF NOT EXISTS "lineRules" JSONB;
