-- Portal agent: verification codes asked of the owner mid-login, and when it last ran.
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "mfaPrompt" TEXT;
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "mfaRequestedAt" TIMESTAMP(3);
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "mfaCodeEnc" TEXT;
ALTER TABLE "utility_accounts" ADD COLUMN IF NOT EXISTS "lastAgentRunAt" TIMESTAMP(3);
