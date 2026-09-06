-- ClickUp integration: a per-user connection, a list per property, a task per bill.
CREATE TABLE "clickup_connections" (
  "id"               TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "tokenEnc"         TEXT NOT NULL,
  "clickupUserId"    TEXT,
  "clickupUserName"  TEXT,
  "teamId"           TEXT,
  "teamName"         TEXT,
  "spaceId"          TEXT,
  "spaceName"        TEXT,
  "folderId"         TEXT,
  "folderName"       TEXT,
  "webhookId"        TEXT,
  "webhookSecretEnc" TEXT,
  "syncBills"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clickup_connections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "clickup_connections_userId_key" ON "clickup_connections"("userId");
ALTER TABLE "clickup_connections" ADD CONSTRAINT "clickup_connections_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "properties" ADD COLUMN "clickupListId" TEXT;
ALTER TABLE "statements" ADD COLUMN "clickupTaskId" TEXT;
