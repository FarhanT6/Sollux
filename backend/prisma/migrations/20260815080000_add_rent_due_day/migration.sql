-- AlterTable: day of month rent is due (drives arrears accrual timing)
ALTER TABLE "leases" ADD COLUMN "rentDueDay" INTEGER;
