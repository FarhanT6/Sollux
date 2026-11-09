-- A check or money order received as rent: when it was deposited (Cash, checks & apps → Checks).
ALTER TABLE "rent_payments" ADD COLUMN IF NOT EXISTS "depositedAt" TIMESTAMP(3);
