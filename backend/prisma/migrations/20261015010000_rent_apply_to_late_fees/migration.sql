-- Per-tenant choice of where a payment goes first (this month or the balance),
-- the choice made on a single payment, and late fees charged automatically.
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "autoLateFee" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "paymentsApplyTo" TEXT NOT NULL DEFAULT 'CURRENT';
ALTER TABLE "rent_payments" ADD COLUMN IF NOT EXISTS "applyTo" TEXT;

CREATE TABLE IF NOT EXISTS "rent_charges" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "periodDate" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'LATE_FEE',
    "amount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rent_charges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "rent_charges_leaseId_periodDate_kind_key" ON "rent_charges"("leaseId", "periodDate", "kind");
DO $$ BEGIN
  ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
