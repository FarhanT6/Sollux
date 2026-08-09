-- Backfill the new fee/charge columns for statements that already existed
-- before these columns were added, so no re-import/re-scrape is required.
-- Idempotent (only touches rows where the target column is still NULL) —
-- safe to run whether or not the column-adding migrations above have
-- already been deployed.

-- 1. penaltiesFees: pull from legacy rawDataJson keys used by scrapers.
UPDATE "statements"
SET "penaltiesFees" = (
  CASE
    WHEN "rawDataJson"->>'penalties' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ("rawDataJson"->>'penalties')::numeric
    WHEN "rawDataJson"->>'lateFee' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ("rawDataJson"->>'lateFee')::numeric
    WHEN "rawDataJson"->>'afterDueDateAmt' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ("rawDataJson"->>'afterDueDateAmt')::numeric
    ELSE NULL
  END
)
WHERE "penaltiesFees" IS NULL;

-- 2. pastDueCarried: pull from legacy rawDataJson keys used by scrapers.
UPDATE "statements"
SET "pastDueCarried" = (
  CASE
    WHEN "rawDataJson"->>'pastDue' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ("rawDataJson"->>'pastDue')::numeric
    WHEN "rawDataJson"->>'previousBalance' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ("rawDataJson"->>'previousBalance')::numeric
    ELSE NULL
  END
)
WHERE "pastDueCarried" IS NULL;

-- 3. chargesExcludingFees: prefer the PDF-import "currentCharges" value if
--    present in rawDataJson, otherwise derive it as amountDue - penaltiesFees
--    (the definition of "due w/o penalties and fees") whenever amountDue is known.
UPDATE "statements"
SET "chargesExcludingFees" = COALESCE(
  (CASE WHEN "rawDataJson"->>'currentCharges' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ("rawDataJson"->>'currentCharges')::numeric ELSE NULL END),
  (CASE WHEN "amountDue" IS NOT NULL THEN "amountDue" - COALESCE("penaltiesFees", 0) ELSE NULL END)
)
WHERE "chargesExcludingFees" IS NULL;
