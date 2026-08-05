-- Outgoing expense matching: hardware-store purchases (Lowe's, Ace,
-- Home Depot, etc.) and utility bill payments, detected the same way as
-- incoming rent transfers but on debit transactions.
ALTER TABLE "bank_accounts" ADD COLUMN "watchForExpenses" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "outgoing_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "plaidTransactionId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "matchType" TEXT,
    "propertyId" TEXT,
    "utilityAccountId" TEXT,
    "category" TEXT,
    "statementId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "appliedType" TEXT,
    "appliedId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outgoing_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outgoing_transactions_plaidTransactionId_key" ON "outgoing_transactions"("plaidTransactionId");
CREATE INDEX "outgoing_transactions_userId_status_idx" ON "outgoing_transactions"("userId", "status");

ALTER TABLE "outgoing_transactions" ADD CONSTRAINT "outgoing_transactions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outgoing_transactions" ADD CONSTRAINT "outgoing_transactions_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outgoing_transactions" ADD CONSTRAINT "outgoing_transactions_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "outgoing_transactions" ADD CONSTRAINT "outgoing_transactions_utilityAccountId_fkey"
  FOREIGN KEY ("utilityAccountId") REFERENCES "utility_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
