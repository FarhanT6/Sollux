-- The share of each mortgage payment that goes toward an escrowed account.
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "escrowMonthlyAmount" DECIMAL(10,2);
