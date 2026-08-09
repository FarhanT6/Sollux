-- First-class fee/past-due/notes fields on Statement, so manual entry, PDF
-- import, and scrapers all agree on one shape instead of some of this data
-- living only inside rawDataJson (e.g. "penalties", "pastDue" keys).
ALTER TABLE "statements" ADD COLUMN "penaltiesFees" DECIMAL(10,2);
ALTER TABLE "statements" ADD COLUMN "pastDueCarried" DECIMAL(10,2);
ALTER TABLE "statements" ADD COLUMN "notes" TEXT;
