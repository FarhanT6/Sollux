-- The owner's computer running the Sollux connector: portal fetches go through a Chrome there.
CREATE TABLE IF NOT EXISTS "connector_devices" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3),
  "relayUrl" TEXT,
  "agent" TEXT,
  CONSTRAINT "connector_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "connector_devices_tokenHash_key" ON "connector_devices"("tokenHash");
CREATE INDEX IF NOT EXISTS "connector_devices_userId_idx" ON "connector_devices"("userId");
DO $$ BEGIN
  ALTER TABLE "connector_devices" ADD CONSTRAINT "connector_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
