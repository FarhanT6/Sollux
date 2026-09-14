-- Pay planner: the account a loan is usually paid from, and money already
-- committed from an account that the bank has not yet taken.
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "payFromBankAccountId" TEXT;
CREATE INDEX IF NOT EXISTS "loans_payFromBankAccountId_idx" ON "loans"("payFromBankAccountId");
ALTER TABLE "loans"
  ADD CONSTRAINT "loans_payFromBankAccountId_fkey"
  FOREIGN KEY ("payFromBankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "pending_outflows" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "bankAccountId" TEXT NOT NULL,
  "amount"        DECIMAL(12,2) NOT NULL,
  "description"   TEXT NOT NULL,
  "kind"          TEXT NOT NULL DEFAULT 'OTHER',
  "expectedDate"  TIMESTAMP(3),
  "loanId"        TEXT,
  "cleared"       BOOLEAN NOT NULL DEFAULT false,
  "clearedAt"     TIMESTAMP(3),
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pending_outflows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "pending_outflows_userId_cleared_idx" ON "pending_outflows"("userId", "cleared");
CREATE INDEX IF NOT EXISTS "pending_outflows_bankAccountId_idx" ON "pending_outflows"("bankAccountId");
ALTER TABLE "pending_outflows"
  ADD CONSTRAINT "pending_outflows_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pending_outflows"
  ADD CONSTRAINT "pending_outflows_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pending_outflows"
  ADD CONSTRAINT "pending_outflows_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
