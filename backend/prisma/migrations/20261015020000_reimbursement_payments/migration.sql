-- Utility reimbursement payments from tenants, and the bills each one covers.
CREATE TABLE IF NOT EXISTS "reimbursement_payments" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "paidDate" TIMESTAMP(3) NOT NULL,
    "method" "RentPaymentMethod" NOT NULL DEFAULT 'OTHER',
    "bankAccountId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reimbursement_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "reimbursement_payments_leaseId_paidDate_idx" ON "reimbursement_payments"("leaseId", "paidDate");

CREATE TABLE IF NOT EXISTS "reimbursement_allocations" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "utilityAccountId" TEXT,
    "statementId" TEXT,
    "category" TEXT NOT NULL,
    "periodDate" TIMESTAMP(3) NOT NULL,
    "invoiceId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    CONSTRAINT "reimbursement_allocations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "reimbursement_allocations_statementId_idx" ON "reimbursement_allocations"("statementId");
CREATE INDEX IF NOT EXISTS "reimbursement_allocations_paymentId_idx" ON "reimbursement_allocations"("paymentId");

DO $$ BEGIN
  ALTER TABLE "reimbursement_payments" ADD CONSTRAINT "reimbursement_payments_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "reimbursement_payments" ADD CONSTRAINT "reimbursement_payments_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "reimbursement_allocations" ADD CONSTRAINT "reimbursement_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "reimbursement_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
