-- SoCalGas, Oct 2026: "Pending Payment 32.13" under Other Charges & Credits
-- takes back a payment the last bill had credited while it was pending; the
-- payment posts again on the same bill, so it counts once. It was read as
-- part of the period's charge ($53.63 instead of $21.50) and the payment as
-- a carried credit (−$18.58 instead of $13.55 past due). Moved out of both
-- (pdfImportService takeOutPendingPayment does this on import from now on).
WITH p AS (
  SELECT s.id, e.key, (e.value)::numeric AS amt
  FROM "statements" s
  CROSS JOIN LATERAL jsonb_each_text(s."rawDataJson"->'chargeBreakdown') AS e(key, value)
  WHERE jsonb_typeof(s."rawDataJson"->'chargeBreakdown') = 'object'
    AND e.key ~* '^\s*(pending payment|payment pending)'
    AND e.value ~ '^[0-9]+(\.[0-9]+)?$'
    AND (e.value)::numeric > 0
)
UPDATE "statements" s
SET "amountDue" = round(s."amountDue" - p.amt, 2),
    "pastDueCarried" = round(s."pastDueCarried" + p.amt, 2),
    "chargesExcludingFees" = CASE WHEN s."chargesExcludingFees" >= p.amt THEN round(s."chargesExcludingFees" - p.amt, 2) ELSE s."chargesExcludingFees" END,
    "rawDataJson" = jsonb_set(s."rawDataJson" #- ARRAY['chargeBreakdown', p.key], '{pendingPaymentTakenOut}', to_jsonb(p.amt))
FROM p
WHERE s.id = p.id
  AND s."amountDue" IS NOT NULL AND s."amountDue" >= p.amt
  AND s."pastDueCarried" IS NOT NULL;
