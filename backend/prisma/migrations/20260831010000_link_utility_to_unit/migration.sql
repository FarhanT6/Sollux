-- Which unit (or shared area) a meter serves. A multi-unit property can hold
-- several meters for one utility, and without this they are indistinguishable
-- from each other on screen.

ALTER TABLE "utility_accounts"
  ADD COLUMN "unitId" TEXT,
  ADD COLUMN "serviceLabel" TEXT;

ALTER TABLE "utility_accounts"
  ADD CONSTRAINT "utility_accounts_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Meters are looked up per unit when rendering a unit's page.
CREATE INDEX "utility_accounts_unitId_idx" ON "utility_accounts"("unitId");
