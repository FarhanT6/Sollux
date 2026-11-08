-- The statement that lists a card payment among its lines.
ALTER TABLE "card_payments" ADD COLUMN IF NOT EXISTS "postedStatementId" TEXT;
CREATE INDEX IF NOT EXISTS "card_payments_postedStatementId_idx" ON "card_payments"("postedStatementId");
