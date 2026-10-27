-- The operating-expense statement's setup for each property.
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "opexSetupJson" JSONB;
