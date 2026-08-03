-- Generic per-property document store for scanned/uploaded mail (bills,
-- taxes, insurance, HOA, legal, misc) that doesn't fit one of the more
-- specific record types. DocumentCategory.OTHER with no link is the
-- fallback "Documents" bucket when auto-sort can't confidently match.
CREATE TYPE "DocumentCategory" AS ENUM ('UTILITY', 'INSURANCE', 'TAX', 'LEGAL', 'HOA', 'EXPENSE_RECEIPT', 'LEASE', 'OTHER');

CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "propertyId" TEXT,
    "category" "DocumentCategory" NOT NULL DEFAULT 'OTHER',
    "title" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "s3Url" TEXT,
    "pageCount" INTEGER NOT NULL DEFAULT 1,
    "sourceType" TEXT NOT NULL DEFAULT 'SCAN',
    "linkedType" TEXT,
    "linkedId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "documents_userId_propertyId_idx" ON "documents"("userId", "propertyId");

ALTER TABLE "documents" ADD CONSTRAINT "documents_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
