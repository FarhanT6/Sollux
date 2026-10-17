-- A portal's saved browser cookies (encrypted), so a trusted device stays trusted across deploys.
CREATE TABLE IF NOT EXISTS "portal_sessions" (
  "utilityAccountId" TEXT NOT NULL,
  "stateEnc" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "portal_sessions_pkey" PRIMARY KEY ("utilityAccountId")
);
