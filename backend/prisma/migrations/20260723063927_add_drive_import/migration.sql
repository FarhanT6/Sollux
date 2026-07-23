-- CreateEnum
CREATE TYPE "DriveImportStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "drive_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drive_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drive_import_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "driveTokenId" TEXT NOT NULL,
    "folderName" TEXT,
    "status" "DriveImportStatus" NOT NULL DEFAULT 'RUNNING',
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "processedFiles" INTEGER NOT NULL DEFAULT 0,
    "autoImported" INTEGER NOT NULL DEFAULT 0,
    "needsReviewJson" JSONB,
    "errorLog" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "drive_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drive_tokens_userId_email_key" ON "drive_tokens"("userId", "email");

-- AddForeignKey
ALTER TABLE "drive_tokens" ADD CONSTRAINT "drive_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
