-- Final lump-sum payoff amount, when it differs from the recurring monthlyPayment
-- (interest-only / negative-amortization loans with a balloon due at maturity).
ALTER TABLE "loans" ADD COLUMN "balloonPaymentAmount" DECIMAL(14,2);
