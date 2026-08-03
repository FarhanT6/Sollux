-- Variable-rate loan structure: rateType FIXED (default, unchanged behavior)
-- or VARIABLE (interestRate auto-recalculated as rateIndex + rateMargin on
-- each rate-adjustment anniversary).
ALTER TABLE "loans" ADD COLUMN "rateType" TEXT NOT NULL DEFAULT 'FIXED';
ALTER TABLE "loans" ADD COLUMN "rateIndex" TEXT;
ALTER TABLE "loans" ADD COLUMN "rateMargin" DECIMAL(6,3);
ALTER TABLE "loans" ADD COLUMN "rateAdjustmentMonths" INTEGER;
ALTER TABLE "loans" ADD COLUMN "nextRateAdjustment" TIMESTAMP(3);

-- User-logged history of a reference rate (e.g. WSJ Prime Rate) over time.
CREATE TABLE "index_rates" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "indexName" TEXT NOT NULL,
    "rate" DECIMAL(6,3) NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "index_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "index_rates_userId_indexName_effectiveDate_idx" ON "index_rates"("userId", "indexName", "effectiveDate");
