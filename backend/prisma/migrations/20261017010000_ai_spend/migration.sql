-- AI spend: a row per Claude call, reusable answers, and portal recipes.
CREATE TABLE IF NOT EXISTS "ai_usage" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "feature" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "userId" TEXT,
  "inputTokens" INTEGER NOT NULL,
  "outputTokens" INTEGER NOT NULL,
  "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DECIMAL(10,6) NOT NULL,
  "fellBack" BOOLEAN NOT NULL DEFAULT false,
  "test" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ai_usage_createdAt_idx" ON "ai_usage"("createdAt");
CREATE INDEX IF NOT EXISTS "ai_usage_feature_createdAt_idx" ON "ai_usage"("feature", "createdAt");

CREATE TABLE IF NOT EXISTS "ai_memos" (
  "key" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_memos_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "portal_recipes" (
  "key" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "steps" JSONB NOT NULL,
  "successes" INTEGER NOT NULL DEFAULT 0,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "portal_recipes_pkey" PRIMARY KEY ("key")
);
