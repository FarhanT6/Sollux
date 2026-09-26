-- A bank debit matched to a loan payment.
ALTER TABLE "outgoing_transactions" ADD COLUMN IF NOT EXISTS "loanId" TEXT;
