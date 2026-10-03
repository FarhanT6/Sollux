-- Late fees logged with payments were added to the bill's amount and
-- penalties but not to its charge list. Add the line to bills that have one.
UPDATE "statements" s
SET "rawDataJson" = jsonb_set(
  CASE WHEN jsonb_typeof(s."rawDataJson") = 'object' THEN s."rawDataJson" ELSE '{}'::jsonb END,
  '{chargeBreakdown}',
  (CASE WHEN jsonb_typeof(s."rawDataJson"->'chargeBreakdown') = 'object' THEN s."rawDataJson"->'chargeBreakdown' ELSE '{}'::jsonb END)
    || jsonb_build_object('Late fee (paid late)', f.total)
)
FROM (
  SELECT "statementId", SUM("lateFeeAdded") AS total
  FROM "payments"
  WHERE "lateFeeAdded" > 0 AND "statementId" IS NOT NULL
  GROUP BY "statementId"
) f
WHERE f."statementId" = s."id"
  AND NOT (COALESCE(s."rawDataJson"->'chargeBreakdown', '{}'::jsonb) ? 'Late fee (paid late)');
