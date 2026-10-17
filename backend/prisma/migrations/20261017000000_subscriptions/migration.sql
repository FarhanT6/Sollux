-- Subscriptions, step 1: the plan tiers. Added on their own: Postgres will
-- not use a new enum value in the transaction that adds it, so the columns
-- and backfill are the next migration.
ALTER TYPE "SubscriptionTier" ADD VALUE IF NOT EXISTS 'STARTER';
ALTER TYPE "SubscriptionTier" ADD VALUE IF NOT EXISTS 'PORTFOLIO';
ALTER TYPE "SubscriptionTier" ADD VALUE IF NOT EXISTS 'COMP';
