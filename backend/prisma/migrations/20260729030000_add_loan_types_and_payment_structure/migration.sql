-- Add new loan types
ALTER TYPE "LoanType" ADD VALUE IF NOT EXISTS 'SELLER_FINANCING';
ALTER TYPE "LoanType" ADD VALUE IF NOT EXISTS 'DSCR';
ALTER TYPE "LoanType" ADD VALUE IF NOT EXISTS 'COMMERCIAL';
ALTER TYPE "LoanType" ADD VALUE IF NOT EXISTS 'HARD_MONEY';

-- Track when a loan's payment structure last changed (e.g. P&I -> interest-only)
ALTER TABLE "loans" ADD COLUMN "paymentStructureChangedAt" TIMESTAMP(3);
