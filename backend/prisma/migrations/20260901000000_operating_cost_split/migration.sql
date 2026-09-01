-- Separate arrears repayment and penalties from what a property costs to run.
-- A bill can carry a payment-plan installment (City of Brawley itemises
-- "Payment Plan" alongside water and sewer); that is repayment of old debt,
-- not this month's operating cost.

ALTER TABLE "statements"
  ADD COLUMN "paymentPlanAmount" DECIMAL(10,2);

ALTER TABLE "users"
  ADD COLUMN "includePenaltiesInOperating" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "includePaymentPlanInOperating" BOOLEAN NOT NULL DEFAULT false;
