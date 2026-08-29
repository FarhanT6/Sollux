-- AlterTable: late fee config + commercial business name
ALTER TABLE "leases" ADD COLUMN "lateFeeAmount" DECIMAL(10,2);
ALTER TABLE "leases" ADD COLUMN "lateFeePercent" DOUBLE PRECISION;
ALTER TABLE "leases" ADD COLUMN "lateFeeGraceDays" INTEGER;
ALTER TABLE "leases" ADD COLUMN "businessName" TEXT;
