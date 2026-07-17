import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { runAnnQuery } from "../utils/annQuery";
import { featureDetection } from "./featureDetection";
import { logger } from "../utils/logger";
import { separateArtistsPreservingOrder } from "../utils/separateArtists";
import {
    AUDIO_FEATURE_COMPONENTS,
    DEFAULT_SIMILARITY_WEIGHTS,
    isDefaultWeights,
    splitAndNormalize,
    type NormalizedWeights,
    type SimilarityWeights,
} from "./similarityWeights";

export interface SimilarTrack {
    id: string;
    title: string;
    duration: number;
    distance: number;
    similarity: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
    // Audio features for vibe match visualization
    energy: number | null;
    valence: number | null;
    danceability: number | null;
    arousal: number | null;
}

// Component weights live in similarityWeights.ts (DEFAULT_SIMILARITY_WEIGHTS
// replaces the historic hardcoded WEIGHTS constant — same numbers). Per-user
// weights arrive pre-validated via findSimilarTracks' weights parameter.

// Normalized weights for features-only mode (sum to 1.0)
const FEATURES_ONLY_WEIGHTS = {
    energy: 0.267,
    valence: 0.222,
    bpm: 0.178,
    danceability: 0.133,
    acousticness: 0.089,
    instrumentalness: 0.067,
    key: 0.044,
};

const CANDIDATE_MULTIPLIER = 5;

function getArtistCapForLimit(limit: number): number {
    if (!Number.isFinite(limit) || limit <= 0) return 2;
    return Math.max(2, Math.floor(limit / 12));
}

function applyArtistDiversityCap(
    tracks: SimilarTrack[],
    limit: number
): SimilarTrack[] {
    if (!Array.isArray(tracks) || tracks.length === 0 || limit <= 0) {
        return [];
    }

    const maxPerArtist = getArtistCapForLimit(limit);
    const selected: SimilarTrack[] = [];
    const overflow: SimilarTrack[] = [];
    const artistCounts = new Map<string, number>();

    for (const track of tracks) {
        const artistKey =
            typeof track.artistId === "string" && track.artistId.length > 0 ?
                track.artistId
            :   `unknown:${track.id}`;
        const count = artistCounts.get(artistKey) ?? 0;

        if (count < maxPerArtist) {
            artistCounts.set(artistKey, count + 1);
            selected.push(track);
            continue;
        }

        overflow.push(track);
    }

    if (selected.length >= limit) {
        return selected.slice(0, limit);
    }

    for (const track of overflow) {
        selected.push(track);
        if (selected.length >= limit) {
            break;
        }
    }

    return separateArtistsPreservingOrder(
        selected,
        (t) => t.artistId || `unknown:${t.id}`,
    ).slice(0, limit);
}

/**
 * Executes findSimilarTracks.
 *
 * `weights` is the user's similarity mix (validated upstream via
 * resolveUserWeights). With DEFAULT_SIMILARITY_WEIGHTS the emitted SQL
 * parameters are numerically identical to the historic hardcoded constants —
 * default callers see byte-for-byte the old behavior.
 */
export async function findSimilarTracks(
    trackId: string,
    limit: number = 20,
    weights: SimilarityWeights = DEFAULT_SIMILARITY_WEIGHTS
): Promise<SimilarTrack[]> {
    const features = await featureDetection.getFeatures();
    const normalized = splitAndNormalize(weights);
    const useDefaults = isDefaultWeights(weights);

    if (features.vibeEmbeddings && features.musicCNN) {
        logger.debug(`[HYBRID-SIMILARITY] Using hybrid mode for track ${trackId}`);
        return findSimilarHybrid(trackId, limit, normalized);
    }

    if (features.vibeEmbeddings && !features.musicCNN) {
        logger.debug(`[HYBRID-SIMILARITY] Using CLAP-only mode for track ${trackId}`);
        return findSimilarClapOnly(trackId, limit);
    }

    if (features.musicCNN && !features.vibeEmbeddings) {
        logger.debug(`[HYBRID-SIMILARITY] Using features-only mode for track ${trackId}`);
        return findSimilarFeaturesOnly(trackId, limit, normalized, useDefaults);
    }

    logger.warn("[HYBRID-SIMILARITY] No similarity features available");
    return [];
}

async function findSimilarHybrid(
    trackId: string,
    limit: number,
    { norm, audioSum, lyricSum }: NormalizedWeights
): Promise<SimilarTrack[]> {
    // Fetch 5x candidates from CLAP to ensure good coverage after re-ranking
    const candidateLimit = Math.max(limit * CANDIDATE_MULTIPLIER, limit);

    if (lyricSum === 0) {
        // Audio-only mix: today's exact query shape with the weights as
        // parameters. audioSum here is always 1 (normalization invariant),
        // so no per-row renormalization is needed.
        const results = await runAnnQuery<SimilarTrack[]>(Prisma.sql`
            WITH source AS (
                SELECT
                    te.embedding,
                    t.energy, t.valence, t.bpm, t.danceability,
                    t.acousticness, t.instrumentalness, t.key, t."keyScale"
                FROM track_embeddings te
                JOIN "Track" t ON te.track_id = t.id
                WHERE te.track_id = ${trackId}
            ),
            clap_candidates AS (
                SELECT
                    te.track_id,
                    1 - (te.embedding <=> (SELECT embedding FROM source)) as clap_sim
                FROM track_embeddings te
                WHERE te.track_id != ${trackId}
                ORDER BY te.embedding <=> (SELECT embedding FROM source)
                LIMIT ${candidateLimit}
            )
            SELECT
                t.id,
                t.title,
                t.duration,
                c.clap_sim as distance,
                (
                    ${norm.clap} * c.clap_sim +
                    ${norm.energy} * (1 - ABS(COALESCE(t.energy, 0.5) - COALESCE(s.energy, 0.5))) +
                    ${norm.valence} * (1 - ABS(COALESCE(t.valence, 0.5) - COALESCE(s.valence, 0.5))) +
                    ${norm.bpm} * bpm_similarity(t.bpm, s.bpm) +
                    ${norm.danceability} * (1 - ABS(COALESCE(t.danceability, 0.5) - COALESCE(s.danceability, 0.5))) +
                    ${norm.acousticness} * (1 - ABS(COALESCE(t.acousticness, 0.5) - COALESCE(s.acousticness, 0.5))) +
                    ${norm.instrumentalness} * (1 - ABS(COALESCE(t.instrumentalness, 0.5) - COALESCE(s.instrumentalness, 0.5))) +
                    ${norm.key} * key_similarity(t.key, t."keyScale", s.key, s."keyScale")
                ) as similarity,
                a.id as "albumId",
                a.title as "albumTitle",
                a."coverUrl" as "albumCoverUrl",
                ar.id as "artistId",
                ar.name as "artistName",
                t.energy,
                t.valence,
                t.danceability,
                t.arousal
            FROM clap_candidates c
            JOIN "Track" t ON c.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            CROSS JOIN source s
            ORDER BY similarity DESC
            LIMIT ${candidateLimit}
        `);

        return applyArtistDiversityCap(results, limit);
    }

    // Lyric-weighted mix. The candidate pool is still CLAP-ANN ordered (a v1
    // limitation: lyric-dominant mixes re-rank a sonic pool). The four lyric
    // terms share ONE availability gate (lyr_ok: both sides lyric-analyzed,
    // non-instrumental, embeddings present) and the score renormalizes per
    // row: (audio + lyr_ok·lyric) / (audioSum + lyr_ok·lyricSum), so tracks
    // without lyrics compete fairly on their audio terms instead of being
    // penalized by unfillable lyric weight (§blend math in the v2 plan).
    const results = await runAnnQuery<SimilarTrack[]>(Prisma.sql`
        WITH source AS (
            SELECT
                te.embedding,
                t.energy, t.valence, t.bpm, t.danceability,
                t.acousticness, t.instrumentalness, t.key, t."keyScale",
                tle.embedding as lyric_embedding,
                tl.sentiment as lyric_sentiment,
                tl."lexicalDiversity" as lyric_lexical,
                tl."readingLevel" as lyric_reading,
                (
                    tl."analysisStatus" = 'completed'
                    AND tl."isInstrumental" = false
                    AND tle.embedding IS NOT NULL
                    AND tl.sentiment IS NOT NULL
                ) as lyric_ok
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            LEFT JOIN track_lyric_embeddings tle ON tle.track_id = t.id
            LEFT JOIN "TrackLyrics" tl ON tl."trackId" = t.id
            WHERE te.track_id = ${trackId}
        ),
        clap_candidates AS (
            SELECT
                te.track_id,
                1 - (te.embedding <=> (SELECT embedding FROM source)) as clap_sim
            FROM track_embeddings te
            WHERE te.track_id != ${trackId}
            ORDER BY te.embedding <=> (SELECT embedding FROM source)
            LIMIT ${candidateLimit}
        )
        SELECT
            t.id,
            t.title,
            t.duration,
            c.clap_sim as distance,
            (
                (
                    ${norm.clap} * c.clap_sim +
                    ${norm.energy} * (1 - ABS(COALESCE(t.energy, 0.5) - COALESCE(s.energy, 0.5))) +
                    ${norm.valence} * (1 - ABS(COALESCE(t.valence, 0.5) - COALESCE(s.valence, 0.5))) +
                    ${norm.bpm} * bpm_similarity(t.bpm, s.bpm) +
                    ${norm.danceability} * (1 - ABS(COALESCE(t.danceability, 0.5) - COALESCE(s.danceability, 0.5))) +
                    ${norm.acousticness} * (1 - ABS(COALESCE(t.acousticness, 0.5) - COALESCE(s.acousticness, 0.5))) +
                    ${norm.instrumentalness} * (1 - ABS(COALESCE(t.instrumentalness, 0.5) - COALESCE(s.instrumentalness, 0.5))) +
                    ${norm.key} * key_similarity(t.key, t."keyScale", s.key, s."keyScale")
                )
                + CASE
                    WHEN s.lyric_ok
                        AND tl."analysisStatus" = 'completed'
                        AND tl."isInstrumental" = false
                        AND tle.embedding IS NOT NULL
                        AND tl.sentiment IS NOT NULL
                    THEN
                        ${norm.lyricSemantic} * GREATEST(0, 1 - (tle.embedding <=> s.lyric_embedding)) +
                        ${norm.lyricSentiment} * (1 - ABS(tl.sentiment - s.lyric_sentiment) / 2) +
                        ${norm.lyricLexical} * (1 - ABS(LEAST(COALESCE(tl."lexicalDiversity", 0), 120) - LEAST(COALESCE(s.lyric_lexical, 0), 120)) / 120) +
                        ${norm.lyricReading} * (1 - LEAST(ABS(COALESCE(tl."readingLevel", 0) - COALESCE(s.lyric_reading, 0)), 12) / 12)
                    ELSE 0
                END
            ) / (
                ${audioSum} + CASE
                    WHEN s.lyric_ok
                        AND tl."analysisStatus" = 'completed'
                        AND tl."isInstrumental" = false
                        AND tle.embedding IS NOT NULL
                        AND tl.sentiment IS NOT NULL
                    THEN ${lyricSum}
                    ELSE 0
                END
            ) as similarity,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName",
            t.energy,
            t.valence,
            t.danceability,
            t.arousal
        FROM clap_candidates c
        JOIN "Track" t ON c.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        LEFT JOIN track_lyric_embeddings tle ON tle.track_id = t.id
        LEFT JOIN "TrackLyrics" tl ON tl."trackId" = t.id
        CROSS JOIN source s
        ORDER BY similarity DESC
        LIMIT ${candidateLimit}
    `);

    return applyArtistDiversityCap(results, limit);
}

async function findSimilarClapOnly(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    const candidateLimit = Math.max(limit * CANDIDATE_MULTIPLIER, limit);
    const results = await runAnnQuery<SimilarTrack[]>(Prisma.sql`
        WITH source AS (
            SELECT embedding FROM track_embeddings WHERE track_id = ${trackId}
        )
        SELECT
            t.id,
            t.title,
            t.duration,
            te.embedding <=> (SELECT embedding FROM source) as distance,
            1 - (te.embedding <=> (SELECT embedding FROM source)) as similarity,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName",
            t.energy,
            t.valence,
            t.danceability,
            t.arousal
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE te.track_id != ${trackId}
        ORDER BY distance
        LIMIT ${candidateLimit}
    `);

    return applyArtistDiversityCap(results, limit);
}

async function findSimilarFeaturesOnly(
    trackId: string,
    limit: number,
    { norm }: NormalizedWeights,
    useDefaults: boolean
): Promise<SimilarTrack[]> {
    // Default mix keeps the historic FEATURES_ONLY_WEIGHTS numbers exactly.
    // A custom mix renormalizes the user's 7 audio-feature weights to sum 1
    // (clap + lyric knobs don't apply — there are no embeddings in this
    // mode); an all-zero feature mix falls back to the historic weights.
    let fw: Record<(typeof AUDIO_FEATURE_COMPONENTS)[number], number> =
        FEATURES_ONLY_WEIGHTS;
    if (!useDefaults) {
        const featSum = AUDIO_FEATURE_COMPONENTS.reduce(
            (sum, key) => sum + norm[key],
            0
        );
        if (featSum > 0) {
            fw = Object.fromEntries(
                AUDIO_FEATURE_COMPONENTS.map((key) => [key, norm[key] / featSum])
            ) as typeof fw;
        }
    }

    const candidateLimit = Math.max(limit * CANDIDATE_MULTIPLIER, limit);
    const results = await prisma.$queryRaw<SimilarTrack[]>`
        WITH source AS (
            SELECT energy, valence, bpm, danceability, acousticness, instrumentalness, key, "keyScale"
            FROM "Track"
            WHERE id = ${trackId}
        )
        SELECT
            t.id,
            t.title,
            t.duration,
            0 as distance,
            (
                ${fw.energy} * (1 - ABS(COALESCE(t.energy, 0.5) - COALESCE(s.energy, 0.5))) +
                ${fw.valence} * (1 - ABS(COALESCE(t.valence, 0.5) - COALESCE(s.valence, 0.5))) +
                ${fw.bpm} * bpm_similarity(t.bpm, s.bpm) +
                ${fw.danceability} * (1 - ABS(COALESCE(t.danceability, 0.5) - COALESCE(s.danceability, 0.5))) +
                ${fw.acousticness} * (1 - ABS(COALESCE(t.acousticness, 0.5) - COALESCE(s.acousticness, 0.5))) +
                ${fw.instrumentalness} * (1 - ABS(COALESCE(t.instrumentalness, 0.5) - COALESCE(s.instrumentalness, 0.5))) +
                ${fw.key} * key_similarity(t.key, t."keyScale", s.key, s."keyScale")
            ) as similarity,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName",
            t.energy,
            t.valence,
            t.danceability,
            t.arousal
        FROM "Track" t
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        CROSS JOIN source s
        WHERE t.id != ${trackId}
            AND t.energy IS NOT NULL
        ORDER BY similarity DESC
        LIMIT ${candidateLimit}
    `;

    return applyArtistDiversityCap(results, limit);
}
