-- How each loan is paid: methods, mailing address, the lender's bank
-- (last four only) and the servicer's payment website.
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "paymentMethods" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "paymentInstructions" TEXT;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "mailingAddress" TEXT;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "payeeBankName" TEXT;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "payeeAccountLast4" TEXT;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "paymentUrl" TEXT;
