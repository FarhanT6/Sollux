-- A processing / convenience fee paid on top of a utility payment.
ALTER TABLE "payments" ADD COLUMN "feeAmount" DECIMAL(10,2);
