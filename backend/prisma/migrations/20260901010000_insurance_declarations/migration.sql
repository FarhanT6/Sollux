-- Coverage detail from a declarations page, plus the distinction between a
-- term's total premium and the installment actually billed.

ALTER TABLE "insurance_policies"
  ADD COLUMN "termPremium" DECIMAL(10,2),
  ADD COLUMN "dwellingLimit" DECIMAL(12,2),
  ADD COLUMN "otherStructuresLimit" DECIMAL(12,2),
  ADD COLUMN "personalPropertyLimit" DECIMAL(12,2),
  ADD COLUMN "lossOfUseLimit" DECIMAL(12,2),
  ADD COLUMN "liabilityLimit" DECIMAL(12,2),
  ADD COLUMN "medicalPaymentsLimit" DECIMAL(12,2),
  ADD COLUMN "deductible" DECIMAL(10,2),
  ADD COLUMN "windHailDeductible" TEXT,
  ADD COLUMN "replacementCostBasis" TEXT,
  ADD COLUMN "agentName" TEXT,
  ADD COLUMN "agentPhone" TEXT,
  ADD COLUMN "agentEmail" TEXT,
  ADD COLUMN "namedInsured" TEXT,
  ADD COLUMN "mortgageePayee" TEXT;
