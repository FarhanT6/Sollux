-- Rent reminders drafted for the owner to send.
CREATE TABLE IF NOT EXISTS "message_drafts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "leaseId" TEXT,
  "kind" TEXT NOT NULL,
  "toName" TEXT,
  "toEmail" TEXT,
  "toPhone" TEXT,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "sms" TEXT,
  "amountDue" DECIMAL(10,2),
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "dedupeKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  CONSTRAINT "message_drafts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "message_drafts_dedupeKey_key" ON "message_drafts"("dedupeKey");
CREATE INDEX IF NOT EXISTS "message_drafts_userId_status_idx" ON "message_drafts"("userId", "status");
