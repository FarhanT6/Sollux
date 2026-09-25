-- Payment terms on tenant utility reimbursement invoices: an optional due
-- date, whom to pay, and how — set by hand per invoice, with per-lease defaults.
ALTER TABLE "utility_reimbursements" ADD COLUMN IF NOT EXISTS "payableTo" TEXT;
ALTER TABLE "utility_reimbursements" ADD COLUMN IF NOT EXISTS "paymentInstructions" TEXT;
ALTER TABLE "reimbursement_invoices" ADD COLUMN IF NOT EXISTS "dueDate" TIMESTAMP(3);
ALTER TABLE "reimbursement_invoices" ADD COLUMN IF NOT EXISTS "payableTo" TEXT;
ALTER TABLE "reimbursement_invoices" ADD COLUMN IF NOT EXISTS "paymentInstructions" TEXT;
