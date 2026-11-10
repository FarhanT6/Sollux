-- Pending money both ways: deposits on their way in as well as checks and payments on their way out.
ALTER TABLE "pending_outflows" ADD COLUMN IF NOT EXISTS "direction" TEXT NOT NULL DEFAULT 'OUT';
ALTER TABLE "pending_outflows" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT;
ALTER TABLE "pending_outflows" ADD COLUMN IF NOT EXISTS "clearedBy" TEXT;
CREATE INDEX IF NOT EXISTS "pending_outflows_sourceRef_idx" ON "pending_outflows"("sourceRef");
