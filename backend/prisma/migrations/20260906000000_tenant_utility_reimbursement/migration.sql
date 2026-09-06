-- Tenant utility reimbursement: per-lease rules, generated invoices, lines.
CREATE TABLE "utility_reimbursements" (
  "id"             TEXT NOT NULL,
  "leaseId"        TEXT NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "rulesJson"      JSONB NOT NULL,
  "accountIdsJson" JSONB,
  "creditBalance"  DECIMAL(10,2) NOT NULL DEFAULT 0,
  "notes"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "utility_reimbursements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "utility_reimbursements_leaseId_key" ON "utility_reimbursements"("leaseId");
ALTER TABLE "utility_reimbursements" ADD CONSTRAINT "utility_reimbursements_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "reimbursement_invoices" (
  "id"              TEXT NOT NULL,
  "reimbursementId" TEXT NOT NULL,
  "periodStart"     TIMESTAMP(3) NOT NULL,
  "periodEnd"       TIMESTAMP(3) NOT NULL,
  "subtotal"        DECIMAL(10,2) NOT NULL,
  "creditApplied"   DECIMAL(10,2) NOT NULL DEFAULT 0,
  "total"           DECIMAL(10,2) NOT NULL,
  "paidAmount"      DECIMAL(10,2) NOT NULL DEFAULT 0,
  "paidAt"          TIMESTAMP(3),
  "status"          TEXT NOT NULL DEFAULT 'DRAFT',
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reimbursement_invoices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reimbursement_invoices_reimbursementId_periodEnd_idx" ON "reimbursement_invoices"("reimbursementId", "periodEnd");
ALTER TABLE "reimbursement_invoices" ADD CONSTRAINT "reimbursement_invoices_reimbursementId_fkey"
  FOREIGN KEY ("reimbursementId") REFERENCES "utility_reimbursements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "reimbursement_invoice_lines" (
  "id"           TEXT NOT NULL,
  "invoiceId"    TEXT NOT NULL,
  "kind"         TEXT NOT NULL,
  "category"     TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "statementId"  TEXT,
  "periodStart"  TIMESTAMP(3),
  "periodEnd"    TIMESTAMP(3),
  "baseAmount"   DECIMAL(10,2) NOT NULL,
  "sharePercent" DOUBLE PRECISION,
  "amount"       DECIMAL(10,2) NOT NULL,
  "sortKey"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reimbursement_invoice_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "reimbursement_invoice_lines_statementId_key" ON "reimbursement_invoice_lines"("statementId");
ALTER TABLE "reimbursement_invoice_lines" ADD CONSTRAINT "reimbursement_invoice_lines_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "reimbursement_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
