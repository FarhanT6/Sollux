-- The individual loans a servicer bills together under one account
-- (student loans: Direct Subsidized + Direct Unsubsidized on one statement).
CREATE TABLE IF NOT EXISTS "loan_components" (
  "id"              TEXT NOT NULL,
  "loanId"          TEXT NOT NULL,
  "label"           TEXT NOT NULL,
  "loanKind"        TEXT,
  "originalAmount"  DECIMAL(14,2),
  "currentBalance"  DECIMAL(14,2),
  "interestRate"    DECIMAL(6,3),
  "monthlyPayment"  DECIMAL(10,2),
  "accruedInterest" DECIMAL(12,2),
  "originationDate" TIMESTAMP(3),
  "maturityDate"    TIMESTAMP(3),
  "notes"           TEXT,
  "sortOrder"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "loan_components_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "loan_components_loanId_idx" ON "loan_components"("loanId");

ALTER TABLE "loan_components"
  ADD CONSTRAINT "loan_components_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
