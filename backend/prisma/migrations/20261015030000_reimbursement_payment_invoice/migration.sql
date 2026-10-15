-- A reimbursement paid toward one invoice remembers it, so money beyond the
-- invoice's lines (an overpayment) is counted there and taken back on delete.
ALTER TABLE "reimbursement_payments" ADD COLUMN IF NOT EXISTS "invoiceId" TEXT;
