-- Browser crashes reported by the app itself, for the auditor.
CREATE TABLE IF NOT EXISTS "client_errors" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT,
  "message"   TEXT NOT NULL,
  "stack"     TEXT,
  "url"       TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_errors_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "client_errors_createdAt_idx" ON "client_errors"("createdAt");
