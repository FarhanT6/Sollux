-- A bill the extractor read as settled (its "Total Due" printed as $0.00)
-- was stored with isPaid in the extraction snapshot but, on some import
-- paths, no amountPaid on the row. The property cards trusted the snapshot
-- and said Paid; the account page read the row and said Overdue. Record on
-- the row what the snapshot says, so every page reads the same fact.
UPDATE "statements"
SET "amountPaid" = GREATEST(COALESCE("amountDue", 0) + COALESCE("pastDueCarried", 0), 0)
WHERE "amountPaid" IS NULL
  AND "rawDataJson" IS NOT NULL
  AND ("rawDataJson"->>'isPaid') = 'true'
  AND "amountDue" IS NOT NULL;
