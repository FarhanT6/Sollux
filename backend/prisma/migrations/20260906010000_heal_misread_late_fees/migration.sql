-- Regex extraction read "a late fee will be assessed … Total Due $870.53"
-- and stored the bill total as the late fee, so fee history showed whole
-- bills as penalties. Extraction now discards a fee that matches the bill's
-- own figures; this clears what was already written — both the column and
-- the rawDataJson.lateFee the API falls back to when the column is empty.
-- A fee equal to the bill's total, its charges before fees, its carried
-- balance, its grand total, or the extraction's previousBalance is that
-- figure misread; one larger than the charges it was added to is not a fee.
WITH misread AS (
  SELECT id
  FROM "statements" s
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      s."penaltiesFees",
      CASE WHEN (s."rawDataJson"->>'lateFee') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ABS((s."rawDataJson"->>'lateFee')::numeric) END
    ) AS fee,
    CASE WHEN (s."rawDataJson"->>'previousBalance') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ABS((s."rawDataJson"->>'previousBalance')::numeric) END AS prev,
    CASE WHEN (s."rawDataJson"->>'currentCharges') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ABS((s."rawDataJson"->>'currentCharges')::numeric) END AS cur
  ) f
  WHERE f.fee IS NOT NULL AND f.fee <> 0
    AND (
         f.fee = ABS(s."amountDue")
      OR f.fee = ABS(s."chargesExcludingFees")
      OR f.fee = ABS(s."pastDueCarried")
      OR (s."amountDue" IS NOT NULL AND s."pastDueCarried" IS NOT NULL AND f.fee = ABS(s."amountDue" + s."pastDueCarried"))
      OR f.fee = f.prev
      OR f.fee = f.cur
      OR (COALESCE(f.cur, s."chargesExcludingFees", s."amountDue") > 0 AND f.fee > COALESCE(f.cur, s."chargesExcludingFees", s."amountDue"))
    )
)
UPDATE "statements" s
SET "penaltiesFees" = NULL,
    "rawDataJson" = CASE WHEN s."rawDataJson" IS NOT NULL THEN s."rawDataJson" - 'lateFee' ELSE s."rawDataJson" END
FROM misread m
WHERE s.id = m.id;
