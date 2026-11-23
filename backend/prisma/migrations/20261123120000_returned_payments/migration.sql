-- Loan payments that came back (a bounced check, a returned transfer): kept apart from loan_payments.
CREATE TABLE IF NOT EXISTS "returned_payments" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "loanId" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "sentOn" TIMESTAMP(3) NOT NULL,
  "periodDate" TIMESTAMP(3),
  "method" TEXT,
  "confirmationNumber" TEXT,
  "billAmount" DECIMAL(10,2),
  "lateFee" DECIMAL(10,2),
  "notes" TEXT,
  "pendingBankAccountId" TEXT,
  "returnedOn" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "bankFee" DECIMAL(10,2),
  "bankFeeExpenseId" TEXT,
  "lenderFee" DECIMAL(10,2),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "returned_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "returned_payments_loanId_idx" ON "returned_payments"("loanId");
CREATE INDEX IF NOT EXISTS "returned_payments_userId_idx" ON "returned_payments"("userId");
DO $$ BEGIN
  ALTER TABLE "returned_payments" ADD CONSTRAINT "returned_payments_loanId_fkey"
    FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
