-- What a running sync job is doing right now, shown live where Fetch was pressed.
ALTER TABLE "sync_jobs" ADD COLUMN IF NOT EXISTS "progress" TEXT;
-- What the portal agent's Claude calls cost for the run.
ALTER TABLE "sync_jobs" ADD COLUMN IF NOT EXISTS "costUsd" DECIMAL(10,4);
