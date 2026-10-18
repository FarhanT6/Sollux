-- The name a bill is addressed to, for a biller's lookup page (account number + name, no sign-in).
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "lookupName" TEXT;
