-- Security-deposit money received on a lease, held apart from rent payments
-- so it never counts as income.
CREATE TABLE IF NOT EXISTS "lease_deposits" (
  "id"            TEXT NOT NULL,
  "leaseId"       TEXT NOT NULL,
  "amount"        DECIMAL(10,2) NOT NULL,
  "paidDate"      TIMESTAMP(3) NOT NULL,
  "method"        "RentPaymentMethod" NOT NULL DEFAULT 'OTHER',
  "bankAccountId" TEXT,
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lease_deposits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "lease_deposits_leaseId_idx" ON "lease_deposits"("leaseId");
CREATE INDEX IF NOT EXISTS "lease_deposits_bankAccountId_idx" ON "lease_deposits"("bankAccountId");

ALTER TABLE "lease_deposits"
  ADD CONSTRAINT "lease_deposits_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lease_deposits"
  ADD CONSTRAINT "lease_deposits_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
