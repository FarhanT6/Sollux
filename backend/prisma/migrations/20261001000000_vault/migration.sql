-- Vault: browser-encrypted sensitive records, their key material, and an access log.
CREATE TABLE IF NOT EXISTS "vault_keys" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "salt" TEXT NOT NULL,
  "iterations" INTEGER NOT NULL,
  "wrappedByPassphrase" TEXT NOT NULL,
  "wrappedByRecovery" TEXT NOT NULL,
  "recoverySalt" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vault_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "vault_keys_userId_key" ON "vault_keys"("userId");

CREATE TABLE IF NOT EXISTS "vault_items" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vault_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "vault_items_userId_idx" ON "vault_items"("userId");

CREATE TABLE IF NOT EXISTS "vault_access_log" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "itemId" TEXT,
  "ip" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vault_access_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "vault_access_log_userId_createdAt_idx" ON "vault_access_log"("userId", "createdAt");
