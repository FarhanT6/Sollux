-- CreateTable: portion of tenant payment that is a utility reimbursement
CREATE TABLE "lease_utility_charges" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lease_utility_charges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lease_utility_charges_leaseId_idx" ON "lease_utility_charges"("leaseId");

ALTER TABLE "lease_utility_charges" ADD CONSTRAINT "lease_utility_charges_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
