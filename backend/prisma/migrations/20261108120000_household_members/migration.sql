-- People in the owner's household, and which of them each personal card, loan, expense and bill belongs to.
CREATE TABLE IF NOT EXISTS "household_members" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "household_members_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "household_members_userId_idx" ON "household_members"("userId");

ALTER TABLE "credit_cards" ADD COLUMN IF NOT EXISTS "memberId" TEXT;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "memberId" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "memberId" TEXT;
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "memberId" TEXT;
