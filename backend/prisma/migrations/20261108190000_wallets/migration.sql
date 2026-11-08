-- Cash and payment-app balances, and the money moved out of them.
CREATE TABLE IF NOT EXISTS "wallets" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "openingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "wallets_userId_kind_key" ON "wallets"("userId", "kind");
CREATE TABLE IF NOT EXISTS "wallet_movements" (
  "id" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "type" TEXT NOT NULL,
  "bankAccountId" TEXT,
  "pairId" TEXT,
  "description" TEXT,
  "source" TEXT,
  "sourceRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_movements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "wallet_movements_walletId_date_idx" ON "wallet_movements"("walletId", "date");
CREATE INDEX IF NOT EXISTS "wallet_movements_sourceRef_idx" ON "wallet_movements"("sourceRef");
DO $$ BEGIN
  ALTER TABLE "wallet_movements" ADD CONSTRAINT "wallet_movements_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
