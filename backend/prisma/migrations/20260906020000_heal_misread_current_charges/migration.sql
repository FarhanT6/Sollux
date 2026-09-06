-- Regex extraction read "current charges" off whatever figure sat nearest
-- the words; on a Fallbrook water bill that was 1,204.31 against a 72.65
-- bill. This period's charges can never exceed the amount due plus what
-- was carried in, so a stored figure that does is replaced by the bill
-- less its fee — in the column and in the rawDataJson the API falls back to.
WITH misread AS (
  SELECT s.id,
         GREATEST(s."amountDue" - COALESCE(s."penaltiesFees", 0), 0) AS fixed
  FROM "statements" s
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      s."chargesExcludingFees",
      CASE WHEN (s."rawDataJson"->>'currentCharges') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (s."rawDataJson"->>'currentCharges')::numeric END
    ) AS cur
  ) f
  WHERE s."amountDue" IS NOT NULL AND s."amountDue" >= 0
    AND f.cur IS NOT NULL AND f.cur >= 0
    AND f.cur > s."amountDue" + GREATEST(COALESCE(s."pastDueCarried", 0), 0) + 0.01
)
UPDATE "statements" s
SET "chargesExcludingFees" = m.fixed,
    "rawDataJson" = CASE WHEN s."rawDataJson" IS NOT NULL
                         THEN jsonb_set(s."rawDataJson", '{currentCharges}', to_jsonb(m.fixed))
                         ELSE s."rawDataJson" END
FROM misread m
WHERE s.id = m.id;
