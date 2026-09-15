-- Paid up front at signing; the amount financed is originalAmount − downPayment.
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "downPayment" DECIMAL(14,2);
