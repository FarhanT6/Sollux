-- AlterTable: shared ("family") account access
ALTER TABLE "users" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "users" ADD CONSTRAINT "users_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: pending invites matched on first sign-in
CREATE TABLE "account_invites" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_invites_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "account_invites_email_idx" ON "account_invites"("email");
CREATE INDEX "account_invites_phone_idx" ON "account_invites"("phone");

ALTER TABLE "account_invites" ADD CONSTRAINT "account_invites_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
