-- Semantic lyric embeddings (nomic-embed-text-v1.5, 768-D), UPSERTed only by
-- the CLAP sidecar's lyric worker. Mirrors track_embeddings.
--
-- Deliberately NO ivfflat index: every v1 consumer is pairwise (x-ray), a
-- candidate re-rank over a CLAP-ANN pool (hybridSimilarity), or a bounded
-- exact scan over the cached map projection (mixer). Skipping ANN here also
-- sidesteps the probes=1 recall bug (roadmap F14). Add an index only if a
-- lyric-seeded ANN *search* ever ships.
--
-- Guarded for idempotency (safe to re-run on legacy DBs).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "track_lyric_embeddings" (
    "track_id" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "model_version" VARCHAR(50) NOT NULL DEFAULT 'nomic-embed-text-v1.5',
    "analyzed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "track_lyric_embeddings_pkey" PRIMARY KEY ("track_id")
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'track_lyric_embeddings_track_id_fkey'
    ) THEN
        ALTER TABLE "track_lyric_embeddings" ADD CONSTRAINT "track_lyric_embeddings_track_id_fkey"
            FOREIGN KEY ("track_id") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "track_lyric_embeddings_model_version_idx"
    ON "track_lyric_embeddings"("model_version");
