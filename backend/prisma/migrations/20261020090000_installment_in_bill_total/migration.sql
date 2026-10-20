-- A payment-agreement installment billed inside a bill belongs in that bill's
-- charge (as the importer already does when it reads a plan box). SDG&E's
-- newer layout prints AGREEMENT AMOUNT 88.04 + CURRENT CHARGES 360.90 (+ past
-- due 368.23) = TOTAL AMOUNT DUE 817.17, and those rows were stored at 360.90,
-- showing 729.13. Only rows whose own printed total proves it — charge +
-- carried + installment (− true-up deferral) equals the stated total to the
-- cent — are changed. Running it again changes nothing (the sum no longer
-- matches once the installment is in).
WITH c AS (
  SELECT s.id,
         s."amountDue" AS a,
         COALESCE(s."pastDueCarried", 0) AS p,
         COALESCE(s."trueUpDeferred", 0) AS d,
         CASE WHEN s."rawDataJson"->>'statedTotalDue' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (s."rawDataJson"->>'statedTotalDue')::numeric END AS t,
         COALESCE(
           s."paymentPlanAmount",
           CASE WHEN s."rawDataJson"->>'paymentPlanAmount' ~ '^[0-9]+(\.[0-9]+)?$' THEN (s."rawDataJson"->>'paymentPlanAmount')::numeric END,
           CASE WHEN s."rawDataJson"->'paymentPlan'->>'installment' ~ '^[0-9]+(\.[0-9]+)?$' THEN (s."rawDataJson"->'paymentPlan'->>'installment')::numeric END,
           (SELECT pp."monthlyAmount" FROM "payment_plans" pp WHERE pp."utilityAccountId" = s."utilityAccountId" AND pp."status" = 'ACTIVE')
         ) AS i
  FROM "statements" s
  WHERE s."amountDue" IS NOT NULL AND s."rawDataJson" IS NOT NULL
)
UPDATE "statements" s
SET "amountDue" = c.a + c.i,
    "paymentPlanAmount" = c.i
FROM c
WHERE s.id = c.id
  AND c.t IS NOT NULL AND c.i IS NOT NULL AND c.i > 0
  AND abs(c.a + c.i + c.p - c.d - c.t) < 0.01
  AND abs(c.a + c.p - c.d - c.t) >= 0.01;
