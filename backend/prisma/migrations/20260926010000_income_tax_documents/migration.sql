-- Income-tax forms (returns, 1098s, 1099s, W-2s, W-9s) and tax payments.
CREATE TABLE IF NOT EXISTS "tax_documents" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "taxYear" INTEGER NOT NULL,
  "jurisdiction" TEXT NOT NULL DEFAULT 'FEDERAL',
  "formType" TEXT NOT NULL,
  "direction" TEXT NOT NULL DEFAULT 'RECEIVED',
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "issuerName" TEXT,
  "recipientName" TEXT,
  "businessName" TEXT,
  "entityType" TEXT,
  "tinLast4" TEXT,
  "address" TEXT,
  "propertyId" TEXT,
  "loanId" TEXT,
  "amount" DECIMAL(14,2),
  "federalWithheld" DECIMAL(14,2),
  "stateWithheld" DECIMAL(14,2),
  "refundOrDue" DECIMAL(14,2),
  "boxes" JSONB,
  "filedDate" TIMESTAMP(3),
  "dueDate" TIMESTAMP(3),
  "documents" JSONB,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tax_documents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "tax_documents_userId_taxYear_idx" ON "tax_documents"("userId", "taxYear");
CREATE INDEX IF NOT EXISTS "tax_documents_userId_formType_idx" ON "tax_documents"("userId", "formType");
DO $$ BEGIN
  ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "tax_payments" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "taxYear" INTEGER NOT NULL,
  "jurisdiction" TEXT NOT NULL DEFAULT 'FEDERAL',
  "kind" TEXT NOT NULL,
  "period" TEXT,
  "dueDate" TIMESTAMP(3),
  "paidDate" TIMESTAMP(3),
  "amount" DECIMAL(14,2) NOT NULL,
  "confirmation" TEXT,
  "method" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tax_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "tax_payments_userId_taxYear_idx" ON "tax_payments"("userId", "taxYear");
