-- A credit card's issuer website login, for fetching its statements with the portal agent.
CREATE TABLE IF NOT EXISTS "card_logins" (
  "cardId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "loginUrl" TEXT,
  "usernameEnc" TEXT NOT NULL,
  "passwordEnc" TEXT NOT NULL,
  "autoFetch" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT,
  "progress" TEXT,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "lastRunAt" TIMESTAMP(3),
  "lastFetchedAt" TIMESTAMP(3),
  "misses" INTEGER NOT NULL DEFAULT 0,
  "mfaPrompt" TEXT,
  "mfaRequestedAt" TIMESTAMP(3),
  "mfaCodeEnc" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "card_logins_pkey" PRIMARY KEY ("cardId")
);
CREATE INDEX IF NOT EXISTS "card_logins_userId_idx" ON "card_logins"("userId");
DO $$ BEGIN
  ALTER TABLE "card_logins" ADD CONSTRAINT "card_logins_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "credit_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
