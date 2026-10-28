-- Indexes for the queries every Finances, Bills and account page runs.
-- Statements (the largest table) had none: each read scanned every row.
CREATE INDEX IF NOT EXISTS "statements_utilityAccountId_statementDate_idx" ON "statements"("utilityAccountId", "statementDate");
CREATE INDEX IF NOT EXISTS "statements_utilityAccountId_dueDate_idx" ON "statements"("utilityAccountId", "dueDate");
CREATE INDEX IF NOT EXISTS "payments_statementId_idx" ON "payments"("statementId");
CREATE INDEX IF NOT EXISTS "utility_accounts_propertyId_idx" ON "utility_accounts"("propertyId");
CREATE INDEX IF NOT EXISTS "leases_unitId_idx" ON "leases"("unitId");
CREATE INDEX IF NOT EXISTS "lease_tenants_tenantId_idx" ON "lease_tenants"("tenantId");
