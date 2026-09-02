-- Per-account payment rules entered by hand. Fee behaviour can be learned from
-- billing history; a shutoff threshold cannot — it appears only on a
-- disconnection notice, if anywhere.

ALTER TABLE "utility_accounts"
  ADD COLUMN "graceDays" INTEGER,
  ADD COLUMN "lateFeeFixed" DECIMAL(10,2),
  ADD COLUMN "lateFeePercent" DECIMAL(5,2),
  ADD COLUMN "shutoffAfterDays" INTEGER,
  ADD COLUMN "paymentRuleNotes" TEXT;
