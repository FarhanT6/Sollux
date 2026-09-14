-- A bill whose account is in credit ("No payment is due. Your account has a
-- credit balance of $47.34", "Total Account Balance -$47.34") was imported
-- with only its period charge, so a $5.26 charge read as $5.26 owed when
-- the provider held $47.34 of the owner's money. The extraction snapshot
-- still carries the negative account balance; the credit carried into the
-- bill is that balance less the period's charge. Restore it wherever no
-- carried balance was recorded and no payment arrangement is involved.
UPDATE "statements"
SET "pastDueCarried" = ROUND(("rawDataJson"->>'totalAccountBalance')::numeric - COALESCE("amountDue", 0), 2)
WHERE "pastDueCarried" IS NULL
  AND "rawDataJson" IS NOT NULL
  AND ("rawDataJson"->>'totalAccountBalance') ~ '^-[0-9]+(\.[0-9]+)?$'
  AND (("rawDataJson"->'paymentPlan') IS NULL OR ("rawDataJson"->>'paymentPlan') = 'null');

-- The same where the bill's stated total was negative and no account
-- balance was printed.
UPDATE "statements"
SET "pastDueCarried" = ROUND(("rawDataJson"->>'statedTotalDue')::numeric - COALESCE("amountDue", 0), 2)
WHERE "pastDueCarried" IS NULL
  AND "rawDataJson" IS NOT NULL
  AND ("rawDataJson"->>'statedTotalDue') ~ '^-[0-9]+(\.[0-9]+)?$'
  AND (("rawDataJson"->'paymentPlan') IS NULL OR ("rawDataJson"->>'paymentPlan') = 'null');
