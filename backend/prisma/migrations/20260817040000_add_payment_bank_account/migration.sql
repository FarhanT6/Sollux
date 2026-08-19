-- AlterTable: which account a utility bill was paid from
ALTER TABLE "payments" ADD COLUMN "bankAccountId" TEXT;

CREATE INDEX "payments_utilityAccountId_paymentDate_idx" ON "payments"("utilityAccountId", "paymentDate");
CREATE INDEX "payments_bankAccountId_idx" ON "payments"("bankAccountId");

ALTER TABLE "payments" ADD CONSTRAINT "payments_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
