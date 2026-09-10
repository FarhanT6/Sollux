-- A tenant already in place when the portfolio was set up may have no known
-- move-in date; the form allowed a blank that could never be saved.
ALTER TABLE "leases" ALTER COLUMN "startDate" DROP NOT NULL;
