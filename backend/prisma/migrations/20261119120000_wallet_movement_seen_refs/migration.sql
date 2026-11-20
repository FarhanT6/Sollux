-- A wallet move seen by both the app's email and the bank feed keeps both references,
-- so re-reading either one never records it twice.
ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "seenRefs" TEXT[] DEFAULT ARRAY[]::TEXT[];
