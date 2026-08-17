-- CreateTable: names a lease's rent may legitimately arrive under (spouse,
-- relative, employer, housing authority), used to match bank descriptors.
CREATE TABLE "lease_payment_aliases" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lease_payment_aliases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lease_payment_aliases_leaseId_idx" ON "lease_payment_aliases"("leaseId");

ALTER TABLE "lease_payment_aliases" ADD CONSTRAINT "lease_payment_aliases_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
