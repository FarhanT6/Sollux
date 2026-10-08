CREATE TABLE IF NOT EXISTS "service_notices" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "utilityAccountId" TEXT,
  "kind" TEXT NOT NULL,
  "provider" TEXT,
  "accountLast4" TEXT,
  "noticeDate" TIMESTAMP(3) NOT NULL,
  "cutoffDate" TIMESTAMP(3),
  "amountDemanded" DECIMAL(12,2),
  "summary" TEXT,
  "pdfS3Key" TEXT,
  "source" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "resolvedAt" TIMESTAMP(3),
  "resolvedReason" TEXT,
  "alertedAt" TIMESTAMP(3),
  "lastRemindedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_notices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "service_notices_userId_status_idx" ON "service_notices"("userId", "status");
CREATE INDEX IF NOT EXISTS "service_notices_utilityAccountId_idx" ON "service_notices"("utilityAccountId");
