-- The background workers' heartbeat (workers/heartbeat.ts).
CREATE TABLE IF NOT EXISTS "worker_heartbeats" (
  "name" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL,
  "paused" BOOLEAN NOT NULL DEFAULT false,
  "active" INTEGER NOT NULL DEFAULT 0,
  "commit" TEXT,
  CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("name")
);
