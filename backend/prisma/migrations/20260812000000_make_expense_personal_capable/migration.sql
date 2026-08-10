-- Expense ownership was entirely derived through the (required) property
-- relation, so a truly personal expense with no property had nowhere to
-- live. Add a direct userId (same pattern Loan already uses for personal
-- loans) and make propertyId optional.

ALTER TABLE "expenses" ADD COLUMN "userId" TEXT;

-- Backfill userId from the linked property for every existing row.
UPDATE "expenses" e
SET "userId" = p."userId"
FROM "properties" p
WHERE p.id = e."propertyId";

ALTER TABLE "expenses" ALTER COLUMN "userId" SET NOT NULL;

ALTER TABLE "expenses" ALTER COLUMN "propertyId" DROP NOT NULL;

CREATE INDEX "expenses_userId_date_idx" ON "expenses"("userId", "date");
