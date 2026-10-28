-- Pages the owner took out of the menu for now.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hiddenNavJson" JSONB;
