-- Insurance installment bills came through with no amountDue (nothing on
-- them reads as a "charge"), leaving the bill unpayable: Mark paid did
-- nothing and a logged payment could not settle it. The bill's stated total,
-- kept in the raw data, less anything carried in, is what it asked for.
UPDATE "statements"
SET "amountDue" = ("rawDataJson"->>'statedTotalDue')::numeric - COALESCE("pastDueCarried", 0)
WHERE "amountDue" IS NULL
  AND "rawDataJson" IS NOT NULL
  AND ("rawDataJson"->>'statedTotalDue') ~ '^-?[0-9]+(\.[0-9]+)?$';
