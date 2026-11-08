-- More of a card statement kept: past due, fees and interest this year, deferred-interest promotions, each line's reference number.
ALTER TABLE "card_statements" ADD COLUMN IF NOT EXISTS "pastDueAmount" DECIMAL(12,2);
ALTER TABLE "card_statements" ADD COLUMN IF NOT EXISTS "feesYtd" DECIMAL(12,2);
ALTER TABLE "card_statements" ADD COLUMN IF NOT EXISTS "interestYtd" DECIMAL(12,2);
ALTER TABLE "card_statements" ADD COLUMN IF NOT EXISTS "promotions" JSONB;
ALTER TABLE "card_transactions" ADD COLUMN IF NOT EXISTS "reference" TEXT;
