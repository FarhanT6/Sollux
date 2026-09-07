-- A credit carried into a bill (SDG&E: "Previous Balance -$5.30 … Current
-- Charges +12.94 … Total Amount Due $7.64") was dropped on import, so the
-- bill's open balance read as its full charges. The Drive path kept only
-- positive carried balances; the extraction snapshot still holds the
-- negative figure. Restore it where the column is empty.
UPDATE "statements"
SET "pastDueCarried" = ("rawDataJson"->>'previousBalance')::numeric
WHERE "pastDueCarried" IS NULL
  AND "rawDataJson" IS NOT NULL
  AND ("rawDataJson"->>'previousBalance') ~ '^-[0-9]+(\.[0-9]+)?$';
