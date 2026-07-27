-- AlterTable: add utilityAccountId to loans (one-to-one optional link)
ALTER TABLE "loans" ADD COLUMN "utilityAccountId" TEXT;

-- CreateIndex: enforce uniqueness (one loan per utility account)
CREATE UNIQUE INDEX "loans_utilityAccountId_key" ON "loans"("utilityAccountId");

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_utilityAccountId_fkey"
  FOREIGN KEY ("utilityAccountId") REFERENCES "utility_accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
