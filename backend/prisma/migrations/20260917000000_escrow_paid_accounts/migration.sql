-- An insurance or tax account paid by the lender out of the mortgage escrow.
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "escrowLoanId" TEXT;
CREATE INDEX IF NOT EXISTS "utility_accounts_escrowLoanId_idx" ON "utility_accounts"("escrowLoanId");
ALTER TABLE "utility_accounts"
  ADD CONSTRAINT "utility_accounts_escrowLoanId_fkey"
  FOREIGN KEY ("escrowLoanId") REFERENCES "loans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
