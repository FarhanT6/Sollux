-- Aging buckets as the provider reports them. A single past-due figure says
-- how much is owed; buckets say how long it has been owed, which is what
-- decides whether an account is drifting or in trouble.

ALTER TABLE "statements" ADD COLUMN "agingBuckets" JSONB;
