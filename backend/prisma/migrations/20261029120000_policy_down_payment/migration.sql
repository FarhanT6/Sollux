-- What a policy took up front, and when; the installments pay the rest of the term premium.
ALTER TABLE "insurance_policies" ADD COLUMN IF NOT EXISTS "downPayment" DECIMAL(10,2);
ALTER TABLE "insurance_policies" ADD COLUMN IF NOT EXISTS "downPaymentDate" TIMESTAMP(3);
