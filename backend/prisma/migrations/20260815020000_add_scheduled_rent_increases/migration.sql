-- CreateTable: scheduled (future) rent increases
CREATE TABLE "scheduled_rent_increases" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "newAmount" DECIMAL(10,2),
    "percent" DOUBLE PRECISION,
    "note" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_rent_increases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scheduled_rent_increases_leaseId_effectiveDate_idx" ON "scheduled_rent_increases"("leaseId", "effectiveDate");

ALTER TABLE "scheduled_rent_increases" ADD CONSTRAINT "scheduled_rent_increases_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
