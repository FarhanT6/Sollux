-- AlterEnum: P2P apps plus a direct deposit into one of the owner's accounts
ALTER TYPE "RentPaymentMethod" ADD VALUE 'VENMO';
ALTER TYPE "RentPaymentMethod" ADD VALUE 'PAYPAL';
ALTER TYPE "RentPaymentMethod" ADD VALUE 'CASH_APP';
ALTER TYPE "RentPaymentMethod" ADD VALUE 'APPLE_CASH';
ALTER TYPE "RentPaymentMethod" ADD VALUE 'BANK_DEPOSIT';

-- AlterTable: which account the money landed in. Nullable, and ON DELETE SET
-- NULL so unlinking a bank account never destroys payment records.
ALTER TABLE "rent_payments" ADD COLUMN "bankAccountId" TEXT;

CREATE INDEX "rent_payments_bankAccountId_idx" ON "rent_payments"("bankAccountId");

ALTER TABLE "rent_payments" ADD CONSTRAINT "rent_payments_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
