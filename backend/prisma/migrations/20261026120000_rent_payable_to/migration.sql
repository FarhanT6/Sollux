-- Who rent is payable to on 3-day notices, per account. It was written into
-- the notice page's code, so every account's notices named the same person.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "rentPayableToJson" JSONB;
