-- Subscriptions, step 2: Stripe status, trial and period end.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subscriptionStatus" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "currentPeriodEnd" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "users_stripeSubscriptionId_key" ON "users"("stripeSubscriptionId");

-- Everyone already using Sollux before billing keeps full access, free.
UPDATE "users" SET "subscriptionTier" = 'COMP' WHERE "stripeSubscriptionId" IS NULL AND "subscriptionTier" IN ('BASIC', 'PRO', 'BUSINESS');

ALTER TABLE "users" ALTER COLUMN "subscriptionTier" SET DEFAULT 'STARTER';
