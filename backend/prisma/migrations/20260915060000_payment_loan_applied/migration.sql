-- How much of a payment came off the balance of the loan linked to the account.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "loanApplied" DECIMAL(12,2);
