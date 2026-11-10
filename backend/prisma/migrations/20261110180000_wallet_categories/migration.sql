-- What money in or spending in a wallet was for, and the records made from it.
ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "propertyId" TEXT;
ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "otherIncomeId" TEXT;
ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "expenseId" TEXT;
-- Handyman work done for other people, as other income.
ALTER TYPE "OtherIncomeCategory" ADD VALUE IF NOT EXISTS 'HANDYMAN_SERVICE';
