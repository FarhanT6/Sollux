-- Audit trail of maturity-date extensions on a loan (e.g. a lender-granted
-- option to extend a balloon/maturity out further).
CREATE TABLE "loan_extensions" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "previousMaturityDate" TIMESTAMP(3),
    "newMaturityDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "extendedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_extensions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "loan_extensions_loanId_idx" ON "loan_extensions"("loanId");

ALTER TABLE "loan_extensions" ADD CONSTRAINT "loan_extensions_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
