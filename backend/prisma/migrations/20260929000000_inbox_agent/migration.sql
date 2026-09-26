-- Inbox agent: import jobs that came from email, when each mailbox was last
-- read, and every message it has handled.
ALTER TABLE "drive_import_jobs" ALTER COLUMN "driveTokenId" DROP NOT NULL;
ALTER TABLE "drive_import_jobs" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'drive';
ALTER TABLE "gmail_tokens" ADD COLUMN IF NOT EXISTS "lastScanAt" TIMESTAMP(3);
ALTER TABLE "gmail_tokens" ADD COLUMN IF NOT EXISTS "lastScanError" TEXT;

CREATE TABLE IF NOT EXISTS "inbox_messages" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "gmailTokenId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "fromAddress" TEXT,
  "subject" TEXT,
  "receivedAt" TIMESTAMP(3),
  "outcome" TEXT NOT NULL,
  "detail" TEXT,
  "utilityAccountId" TEXT,
  "importJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "inbox_messages_gmailTokenId_messageId_key" ON "inbox_messages"("gmailTokenId", "messageId");
CREATE INDEX IF NOT EXISTS "inbox_messages_userId_createdAt_idx" ON "inbox_messages"("userId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_gmailTokenId_fkey" FOREIGN KEY ("gmailTokenId") REFERENCES "gmail_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
