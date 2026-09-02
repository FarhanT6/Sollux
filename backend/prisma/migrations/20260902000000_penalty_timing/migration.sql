-- When a penalty applies and what the bill becomes if it does. Providers print
-- both on the statement; without them, predicting a late fee is guesswork.

ALTER TABLE "statements"
  ADD COLUMN "penaltyDate" TIMESTAMP(3),
  ADD COLUMN "amountAfterDueDate" DECIMAL(10,2);
