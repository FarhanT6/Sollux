-- Payments read from Zelle / Venmo / Cash App / Apple Cash / PayPal emails
-- join the Incoming Payments queue. The account the money landed in is known
-- only by its last 4 digits, so it may match none of the owner's accounts.
ALTER TABLE "incoming_transactions" ALTER COLUMN "bankAccountId" DROP NOT NULL;
ALTER TABLE "incoming_transactions" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'bank';
ALTER TABLE "incoming_transactions" ADD COLUMN IF NOT EXISTS "confirmation" TEXT;
ALTER TABLE "incoming_transactions" ADD COLUMN IF NOT EXISTS "memo" TEXT;
ALTER TABLE "incoming_transactions" ADD COLUMN IF NOT EXISTS "depositLast4" TEXT;
