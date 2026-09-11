-- Cards as payment sources: a debit-card type, the card's network and expiry.
-- Only the last four digits are ever stored.
ALTER TYPE "BankAccountType" ADD VALUE IF NOT EXISTS 'DEBIT_CARD';
ALTER TABLE "bank_accounts" ADD COLUMN IF NOT EXISTS "cardNetwork" TEXT;
ALTER TABLE "bank_accounts" ADD COLUMN IF NOT EXISTS "cardExpiry" TEXT;
