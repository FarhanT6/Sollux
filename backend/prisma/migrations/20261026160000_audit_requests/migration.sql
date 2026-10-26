-- Free portfolio audit requests from the landing page.
CREATE TABLE IF NOT EXISTS "audit_requests" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "properties" INTEGER,
  "currentTools" TEXT,
  "notes" TEXT,
  "fileKeysJson" JSONB,
  "status" TEXT NOT NULL DEFAULT 'new',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "audit_requests_createdAt_idx" ON "audit_requests"("createdAt");
