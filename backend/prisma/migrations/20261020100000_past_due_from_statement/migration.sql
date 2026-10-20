-- Every statement row shows the bill's total with what it carried in (past
-- due, or a credit) beneath it. Rows that were kept at an earlier reading's
-- figures when the PDF came in never got the past due the PDF printed: Rincon
-- Water's Sep bill (237.82 current + 518.67 past due = 756.49) showed 237.82.
-- The PDF's own reading is in rawDataJson; fill the carried balance from it
-- where the row has none:
--   1. the bill's previous balance, when it adds up to the bill's printed
--      total (or no total was printed);
--   2. otherwise what the printed total says beyond this period's charge.
-- Rows that already carry a balance are left alone. Runs after the
-- installment migration (20261020090000), so an agreement installment is
-- already in the charge and is not mistaken for past due.
WITH c AS (
  SELECT s.id,
         s."amountDue" AS a,
         COALESCE(s."trueUpDeferred", 0) AS d,
         CASE WHEN s."rawDataJson"->>'statedTotalDue' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (s."rawDataJson"->>'statedTotalDue')::numeric END AS t,
         CASE WHEN s."rawDataJson"->>'previousBalance' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (s."rawDataJson"->>'previousBalance')::numeric END AS prev
  FROM "statements" s
  WHERE s."pastDueCarried" IS NULL AND s."amountDue" IS NOT NULL AND s."rawDataJson" IS NOT NULL
    AND COALESCE(s."rawDataJson"->>'documentKind', 'bill') = 'bill'
),
fill AS (
  SELECT id,
         CASE
           WHEN prev IS NOT NULL AND abs(prev) > 0.005 AND (t IS NULL OR abs(a - d + prev - t) < 0.01) THEN prev
           WHEN t IS NOT NULL AND abs(t - (a - d)) > 0.01 THEN round(t - (a - d), 2)
         END AS carried
  FROM c
)
UPDATE "statements" s
SET "pastDueCarried" = f.carried
FROM fill f
WHERE s.id = f.id AND f.carried IS NOT NULL;
