-- AlterEnum: assistance programs pay rent on a tenant's behalf
ALTER TYPE "RentPaymentMethod" ADD VALUE 'RENTAL_ASSISTANCE';

-- CreateEnum: committed-but-not-received money is tracked separately so it
-- never counts as collected rent
CREATE TYPE "RentPaymentStatus" AS ENUM ('PENDING', 'RECEIVED');

-- AlterTable. Existing rows were all real receipts, so they default to
-- RECEIVED and nothing about current balances changes.
ALTER TABLE "rent_payments"
  ADD COLUMN "status" "RentPaymentStatus" NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN "expectedDate" TIMESTAMP(3);

CREATE INDEX "rent_payments_status_idx" ON "rent_payments"("status");
