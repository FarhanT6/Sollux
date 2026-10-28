-- App-wide settings changed from the app (Settings → AI usage) rather than
-- Render's environment. The month's AI budget starts at $75: tax lookups for a
-- whole portfolio (about $0.25–$0.90 a property) did not fit in $25.
CREATE TABLE IF NOT EXISTS "app_settings" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);
INSERT INTO "app_settings" ("key", "value", "updatedAt") VALUES ('AI_MONTHLY_BUDGET', '75', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
