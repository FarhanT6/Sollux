-- "Re-read statements" filed a reading it could not match to a bill as a new
-- statement (a $0.00 bill dated the day of the re-read) instead of updating the
-- statement the PDF came from. Such a row shares its PDF with the statement it
-- was read from and was created after it. Removed when nothing was logged
-- against it; the statement the PDF belongs to stays.
DELETE FROM "statements" s
USING "statements" o
WHERE s."pdfS3Key" IS NOT NULL
  AND s."pdfS3Key" = o."pdfS3Key"
  AND s."utilityAccountId" = o."utilityAccountId"
  AND s.id <> o.id
  AND s."createdAt" > o."createdAt"
  AND s."createdAt" >= '2026-10-27'
  AND NOT EXISTS (SELECT 1 FROM "payments" p WHERE p."statementId" = s.id);
