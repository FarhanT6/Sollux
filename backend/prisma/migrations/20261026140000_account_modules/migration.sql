-- Optional modules per account (tenants & operations, books & reporting,
-- personal & vault). Existing accounts stay null, which is every module.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "modulesJson" JSONB;
