-- Add encrypted full account number to loans (previously only last-4 was captured)
ALTER TABLE "loans" ADD COLUMN "accountNumberEnc" TEXT;
