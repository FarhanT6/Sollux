-- Emails still to read when a run stopped at its document limit (progress, not an error).
ALTER TABLE "gmail_tokens" ADD COLUMN IF NOT EXISTS "backlog" INTEGER;
