-- Where a property's last tax lookup on the county site stands.
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "taxLookupJson" JSONB;
