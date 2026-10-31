-- The owner's short name for what a bank account is for, shown after its last four digits.
ALTER TABLE "bank_accounts" ADD COLUMN IF NOT EXISTS "nickname" TEXT;
