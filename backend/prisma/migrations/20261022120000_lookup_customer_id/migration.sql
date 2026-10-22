-- The customer ID a bill lookup page asks for beside the account number
-- (City of El Centro's Tyler Munis self service).
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "lookupCustomerId" TEXT;
