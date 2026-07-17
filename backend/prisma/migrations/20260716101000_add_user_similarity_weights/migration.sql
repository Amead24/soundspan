-- Per-user similarity component weights ("weight mixer"); NULL = defaults.
-- Nullable ADD COLUMN: metadata-only, instant. Guarded for idempotency.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "similarityWeights" JSONB;
