-- AmTrust's portal "Payments Made" tab (the date and amount of each payment)
-- was saved as the statement and read as an invoice-dated installment
-- schedule, so every fetch filed a scheduled "bill" for each payment —
-- Jun 9 $539.80, Apr 21 $254.90, Jul 13 $234.90 — beside the real bills,
-- and deleting them did not help: the next fetch filed them again. The
-- reader now files those rows as payments (pdfImportService). The rows
-- already filed go: invoice-dated scheduled rows (only ever written since
-- 20261023090000) that match a payment on the account to the cent, paid
-- within a day of the row's date. A payment linked to one moves to the
-- newest real bill issued on or before it.
CREATE TEMP TABLE pay_rows ON COMMIT DROP AS
SELECT s.id, s."utilityAccountId" AS account_id
FROM "statements" s
WHERE s."isScheduled" = true
  AND s."rawDataJson"->>'scheduleDates' = 'invoice'
  AND EXISTS (
    SELECT 1 FROM "payments" p
    WHERE p."utilityAccountId" = s."utilityAccountId"
      AND abs(p.amount - s."amountDue") < 0.01
      AND p."paymentDate" BETWEEN s."statementDate" - interval '1 day' AND s."statementDate" + interval '2 days'
  );

UPDATE "payments" p
SET "statementId" = (
  SELECT r.id FROM "statements" r
  WHERE r."utilityAccountId" = p."utilityAccountId" AND r."isScheduled" = false AND r."isDownPayment" = false
    AND r."statementDate" <= p."paymentDate"
  ORDER BY r."statementDate" DESC LIMIT 1
)
WHERE p."statementId" IN (SELECT id FROM pay_rows);

DELETE FROM "statements" WHERE id IN (SELECT id FROM pay_rows);

-- A saved route that goes to a "Payments Made" tab replays straight back to
-- it without Claude; dropped, so the next fetch finds the installments tab.
DELETE FROM "portal_recipes" WHERE steps::text ILIKE '%payments made%';
