-- Lyric analysis result columns on TrackLyrics.
-- Written ONLY by the CLAP sidecar's lyric worker (psycopg2), except
-- analysisStatus flips by the backend enrichment worker — same single-writer
-- contract as Track.vibeAnalysis*. All columns nullable or defaulted so the
-- ADD COLUMNs are metadata-only (instant) and old code keeps working.
-- Guarded for idempotency (safe to re-run on legacy DBs).
ALTER TABLE "TrackLyrics" ADD COLUMN IF NOT EXISTS "sentiment" DOUBLE PRECISION;
ALTER TABLE "TrackLyrics" ADD COLUMN IF NOT EXISTS "lexicalDiversity" DOUBLE PRECISION;
ALTER TABLE "TrackLyrics" ADD COLUMN IF NOT EXISTS "readingLevel" DOUBLE PRECISION;
ALTER TABLE "TrackLyrics" ADD COLUMN IF NOT EXISTS "isInstrumental" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TrackLyrics" ADD COLUMN IF NOT EXISTS "analysisStatus" TEXT;
ALTER TABLE "TrackLyrics" ADD COLUMN IF NOT EXISTS "analysisStartedAt" TIMESTAMP(3);
ALTER TABLE "TrackLyrics" ADD COLUMN IF NOT EXISTS "analysisError" TEXT;
ALTER TABLE "TrackLyrics" ADD COLUMN IF NOT EXISTS "analysisRetryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TrackLyrics" ADD COLUMN IF NOT EXISTS "analysisVersion" TEXT;
ALTER TABLE "TrackLyrics" ADD COLUMN IF NOT EXISTS "analyzedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "TrackLyrics_analysisStatus_idx" ON "TrackLyrics"("analysisStatus");
