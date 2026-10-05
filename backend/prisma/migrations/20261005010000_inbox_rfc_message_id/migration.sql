ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "rfcMessageId" TEXT;
CREATE INDEX IF NOT EXISTS "inbox_messages_userId_rfcMessageId_idx" ON "inbox_messages"("userId", "rfcMessageId");
