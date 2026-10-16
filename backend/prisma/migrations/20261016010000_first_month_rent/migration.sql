-- Rent owed for the start month of a lease that starts partway through it.
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "firstMonthRent" DECIMAL(10,2);
