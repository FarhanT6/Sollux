-- Rent collection (Stripe Connect), the tenant portal, and repair requests.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripeConnectId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "connectChargesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "connectPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS "users_stripeConnectId_key" ON "users"("stripeConnectId");

ALTER TABLE "rent_payments" ADD COLUMN IF NOT EXISTS "stripePaymentIntentId" TEXT;
ALTER TABLE "rent_payments" ADD COLUMN IF NOT EXISTS "tenantFee" DECIMAL(10,2);
CREATE UNIQUE INDEX IF NOT EXISTS "rent_payments_stripePaymentIntentId_key" ON "rent_payments"("stripePaymentIntentId");

CREATE TABLE IF NOT EXISTS "tenant_portal_access" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "email" TEXT,
  "inviteToken" TEXT,
  "inviteExpiresAt" TIMESTAMP(3),
  "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP(3),
  "clerkUserId" TEXT,
  "stripeCustomerId" TEXT,
  "autopay" BOOLEAN NOT NULL DEFAULT false,
  "autopayMethodId" TEXT,
  "autopayMethodType" TEXT,
  "autopayLabel" TEXT,
  "disabled" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "tenant_portal_access_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_portal_access_tenantId_key" ON "tenant_portal_access"("tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_portal_access_inviteToken_key" ON "tenant_portal_access"("inviteToken");
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_portal_access_clerkUserId_key" ON "tenant_portal_access"("clerkUserId");
CREATE INDEX IF NOT EXISTS "tenant_portal_access_ownerUserId_idx" ON "tenant_portal_access"("ownerUserId");

CREATE TABLE IF NOT EXISTS "maintenance_requests" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "unitId" TEXT,
  "leaseId" TEXT,
  "tenantId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'OTHER',
  "urgency" TEXT NOT NULL DEFAULT 'ROUTINE',
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "photoKeys" JSONB NOT NULL DEFAULT '[]',
  "permissionToEnter" BOOLEAN NOT NULL DEFAULT false,
  "availability" TEXT,
  "scheduledFor" TIMESTAMP(3),
  "vendor" TEXT,
  "cost" DECIMAL(10,2),
  "expenseId" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL DEFAULT 'TENANT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "maintenance_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "maintenance_requests_ownerUserId_status_idx" ON "maintenance_requests"("ownerUserId", "status");
CREATE INDEX IF NOT EXISTS "maintenance_requests_tenantId_idx" ON "maintenance_requests"("tenantId");

CREATE TABLE IF NOT EXISTS "maintenance_updates" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_updates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "maintenance_updates_requestId_idx" ON "maintenance_updates"("requestId");
DO $$ BEGIN
  ALTER TABLE "maintenance_updates" ADD CONSTRAINT "maintenance_updates_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "maintenance_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
