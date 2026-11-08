-- Credits toward rent: no money received, and what each was for.
ALTER TYPE "RentPaymentMethod" ADD VALUE IF NOT EXISTS 'CREDIT';
ALTER TABLE "rent_payments" ADD COLUMN IF NOT EXISTS "creditFor" TEXT;
ALTER TABLE "rent_payments" ADD COLUMN IF NOT EXISTS "expenseId" TEXT;
ALTER TABLE "rent_payments" ADD COLUMN IF NOT EXISTS "notIncome" BOOLEAN NOT NULL DEFAULT false;
