-- Importing used to write a bill's "Payments Received" figure — the payment
-- that settled the PREVIOUS cycle — into that bill's own amountPaid, and the
-- derived Payment record for it was dated the same day as the bill that
-- reported it. Both made freshly imported bills read Paid while their own
-- charge sat unpaid. The import code no longer does either; this repairs
-- what it already wrote, so the fix does not depend on re-importing.

-- 1. amountPaid that merely echoes the bill's own paymentsReceived is
--    bill-derived, not something the owner recorded. Clear it. An amountPaid
--    the owner set by hand, or one seeded from a genuine zero-balance bill,
--    does not equal that figure and is left alone.
UPDATE "statements"
SET "amountPaid" = NULL
WHERE "amountPaid" IS NOT NULL
  AND "rawDataJson" IS NOT NULL
  AND ("rawDataJson"->>'paymentsReceived') ~ '^-?[0-9]+(\.[0-9]+)?$'
  AND "amountPaid" = ABS(("rawDataJson"->>'paymentsReceived')::numeric);

-- 2. A payment a bill confirms receiving had arrived before that bill was
--    issued. Date it the day before, so it settles the prior cycle and is not
--    counted against the bill that reported it.
UPDATE "payments" p
SET "paymentDate" = s."statementDate" - INTERVAL '1 day'
FROM "statements" s
WHERE p."notes" LIKE '%[from-statement:' || s."id" || ']%'
  AND p."paymentDate" >= s."statementDate";
