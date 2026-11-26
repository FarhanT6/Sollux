-- The mailing ZIP code a bill lookup page asks for (California FAIR Plan).
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "lookupZip" TEXT;
