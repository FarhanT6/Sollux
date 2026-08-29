-- Rent-via-P2P matching: bank accounts opt in to being scanned for
-- Zelle/Venmo/PayPal/Cash App-style incoming transfers, synced via
-- Plaid's /transactions/sync (cursor-based incremental sync).
ALTER TABLE "bank_accounts" ADD COLUMN "watchForRentPayments" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "plaid_items" ADD COLUMN "plaidTxCursor" TEXT;

CREATE TABLE "incoming_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "plaidTransactionId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT,
    "matchedLeaseId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "rentPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incoming_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "incoming_transactions_plaidTransactionId_key" ON "incoming_transactions"("plaidTransactionId");
CREATE INDEX "incoming_transactions_userId_status_idx" ON "incoming_transactions"("userId", "status");

ALTER TABLE "incoming_transactions" ADD CONSTRAINT "incoming_transactions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incoming_transactions" ADD CONSTRAINT "incoming_transactions_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incoming_transactions" ADD CONSTRAINT "incoming_transactions_matchedLeaseId_fkey"
  FOREIGN KEY ("matchedLeaseId") REFERENCES "leases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
