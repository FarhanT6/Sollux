-- A card statement whose figures came from a "your statement is ready" email, not the statement PDF.
ALTER TABLE "card_statements" ADD COLUMN IF NOT EXISTS "fromEmail" BOOLEAN NOT NULL DEFAULT false;
