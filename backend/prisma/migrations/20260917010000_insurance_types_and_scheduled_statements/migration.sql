-- Insurance comes in more kinds than property cover: auto, renters, health,
-- dental, vision, life, business.
ALTER TYPE "InsuranceType" ADD VALUE IF NOT EXISTS 'AUTO';
ALTER TYPE "InsuranceType" ADD VALUE IF NOT EXISTS 'RENTERS';
ALTER TYPE "InsuranceType" ADD VALUE IF NOT EXISTS 'HEALTH';
ALTER TYPE "InsuranceType" ADD VALUE IF NOT EXISTS 'DENTAL';
ALTER TYPE "InsuranceType" ADD VALUE IF NOT EXISTS 'VISION';
ALTER TYPE "InsuranceType" ADD VALUE IF NOT EXISTS 'LIFE';
ALTER TYPE "InsuranceType" ADD VALUE IF NOT EXISTS 'BUSINESS';

-- An installment taken from a policy's payment schedule before its bill arrives.
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "isScheduled" BOOLEAN NOT NULL DEFAULT false;
