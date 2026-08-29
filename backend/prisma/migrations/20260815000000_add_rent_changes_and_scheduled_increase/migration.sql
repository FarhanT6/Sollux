-- AlterTable: scheduled next rent increase fields on the lease
ALTER TABLE "leases" ADD COLUMN "nextIncreaseDate" TIMESTAMP(3);
ALTER TABLE "leases" ADD COLUMN "nextIncreaseAmount" DECIMAL(10,2);
ALTER TABLE "leases" ADD COLUMN "nextIncreasePercent" DOUBLE PRECISION;
ALTER TABLE "leases" ADD COLUMN "nextIncreaseNote" TEXT;

-- CreateTable: rent change history
CREATE TABLE "rent_changes" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "previousAmount" DECIMAL(10,2),
    "newAmount" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rent_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rent_changes_leaseId_effectiveDate_idx" ON "rent_changes"("leaseId", "effectiveDate");

ALTER TABLE "rent_changes" ADD CONSTRAINT "rent_changes_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
