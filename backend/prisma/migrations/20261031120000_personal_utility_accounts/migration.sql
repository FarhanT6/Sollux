-- A utility account can be the owner's own bill rather than a cost of its property.
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "isPersonal" BOOLEAN NOT NULL DEFAULT false;
