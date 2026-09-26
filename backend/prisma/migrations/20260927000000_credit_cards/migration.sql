-- Personal finance: credit cards, their statements, payments and transactions.
CREATE TABLE IF NOT EXISTS "credit_cards" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "issuer" TEXT, "network" TEXT, "last4" TEXT, "cardholderName" TEXT,
  "isBusiness" BOOLEAN NOT NULL DEFAULT false, "propertyId" TEXT, "bankAccountId" TEXT, "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "openedDate" TIMESTAMP(3), "closedDate" TIMESTAMP(3), "expiration" TEXT,
  "creditLimit" DECIMAL(12,2), "cashAdvanceLimit" DECIMAL(12,2), "currentBalance" DECIMAL(12,2), "balanceAsOf" TIMESTAMP(3),
  "statementClosingDay" INTEGER, "paymentDueDay" INTEGER,
  "purchaseApr" DECIMAL(6,3), "cashAdvanceApr" DECIMAL(6,3), "balanceTransferApr" DECIMAL(6,3), "penaltyApr" DECIMAL(6,3),
  "introApr" DECIMAL(6,3), "introAprType" TEXT, "introAprEndDate" TIMESTAMP(3),
  "annualFee" DECIMAL(10,2), "annualFeeMonth" INTEGER, "foreignTransactionFee" DECIMAL(5,2), "lateFee" DECIMAL(10,2),
  "balanceTransferFee" DECIMAL(5,2), "cashAdvanceFee" DECIMAL(5,2),
  "rewardsProgram" TEXT, "rewardsType" TEXT, "rewardsBalance" DECIMAL(14,2), "rewardsCentsPerPoint" DECIMAL(6,3), "rewardsEarnRates" TEXT,
  "autopay" TEXT NOT NULL DEFAULT 'NONE', "autopayAmount" DECIMAL(12,2), "autopayFromBankAccountId" TEXT,
  "authorizedUsers" JSONB, "loginUrl" TEXT, "phone" TEXT, "notes" TEXT, "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credit_cards_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "credit_cards_userId_idx" ON "credit_cards"("userId");

CREATE TABLE IF NOT EXISTS "card_statements" (
  "id" TEXT NOT NULL, "cardId" TEXT NOT NULL, "periodStart" TIMESTAMP(3), "closingDate" TIMESTAMP(3) NOT NULL, "dueDate" TIMESTAMP(3),
  "previousBalance" DECIMAL(12,2), "paymentsCredits" DECIMAL(12,2), "purchases" DECIMAL(12,2), "balanceTransfers" DECIMAL(12,2),
  "cashAdvances" DECIMAL(12,2), "feesCharged" DECIMAL(12,2), "interestCharged" DECIMAL(12,2), "newBalance" DECIMAL(12,2) NOT NULL,
  "minimumPayment" DECIMAL(12,2), "creditLimit" DECIMAL(12,2), "availableCredit" DECIMAL(12,2), "purchaseApr" DECIMAL(6,3),
  "cashAdvanceApr" DECIMAL(6,3), "rewardsEarned" DECIMAL(14,2), "rewardsBalance" DECIMAL(14,2), "daysInCycle" INTEGER,
  "minPayoffMonths" INTEGER, "minPayoffTotal" DECIMAL(12,2), "documents" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "card_statements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "card_statements_cardId_closingDate_key" ON "card_statements"("cardId", "closingDate");

CREATE TABLE IF NOT EXISTS "card_payments" (
  "id" TEXT NOT NULL, "cardId" TEXT NOT NULL, "statementId" TEXT, "date" TIMESTAMP(3) NOT NULL, "amount" DECIMAL(12,2) NOT NULL,
  "fromBankAccountId" TEXT, "confirmation" TEXT, "method" TEXT, "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "card_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "card_payments_cardId_date_idx" ON "card_payments"("cardId", "date");

CREATE TABLE IF NOT EXISTS "card_transactions" (
  "id" TEXT NOT NULL, "cardId" TEXT NOT NULL, "statementId" TEXT, "date" TIMESTAMP(3) NOT NULL, "postDate" TIMESTAMP(3),
  "description" TEXT NOT NULL, "merchant" TEXT, "amount" DECIMAL(12,2) NOT NULL, "kind" TEXT NOT NULL DEFAULT 'PURCHASE',
  "category" TEXT, "cardholder" TEXT, "isBusiness" BOOLEAN NOT NULL DEFAULT false, "propertyId" TEXT, "expenseId" TEXT, "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "card_transactions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "card_transactions_cardId_date_idx" ON "card_transactions"("cardId", "date");
DO $$ BEGIN
  ALTER TABLE "card_statements" ADD CONSTRAINT "card_statements_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "credit_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "credit_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "card_statements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "credit_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "card_statements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
