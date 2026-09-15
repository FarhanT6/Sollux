-- The owner's word over every paid inference: 'UNPAID' keeps a bill open.
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "paidOverride" TEXT;
