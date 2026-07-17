import { Router } from "express";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { runAnnQuery } from "../utils/annQuery";
import { redisClient } from "../utils/redis";
import { parseEmbedding } from "../utils/embedding";
import { requireAuth } from "../middleware/auth";
import { findSimilarTracks } from "../services/hybridSimilarity";
import {
    DEFAULT_SIMILARITY_WEIGHTS,
    isDefaultWeights,
    resolveUserWeights,
    similarityWeightsSchema,
    splitAndNormalize,
} from "../services/similarityWeights";
import {
    computeMapProjection,
    getCachedProjection,
} from "../services/umapProjection";
import {
    applyTrackPreferenceOrderBias,
    applyTrackPreferenceSimilarityBias,
    resolveTrackPreference,
    TRACK_DISLIKE_ENTITY_TYPE,
} from "../services/trackPreference";
import {
    getVocabulary,
    expandQueryWithVocabulary,
    rerankWithFeatures,
    loadVocabulary,
    VocabTerm
} from "../services/vibeVocabulary";
import { MOOD_CONFIG, VALID_MOODS, MoodType, MOOD_BUCKET_MIN_SCORE } from "../services/moodBucketService";

const router = Router();

// Load vocabulary at module initialization
loadVocabulary();

const TEXT_EMBED_REQUEST_STREAM = "audio:text:embed:requests";
const TEXT_EMBED_RESPONSE_PREFIX = "audio:text:embed:response:";
const TEXT_EMBED_TIMEOUT_SECONDS = 30;

interface TextSearchResult {
    id: string;
    title: string;
    duration: number;
    trackNo: number;
    distance: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
    // Audio features for re-ranking
    energy: number | null;
    valence: number | null;
    danceability: number | null;
    acousticness: number | null;
    instrumentalness: number | null;
    arousal: number | null;
    speechiness: number | null;
}

async function buildTrackPreferenceScoreMapForUser(
    userId: string | undefined,
    trackIds: string[]
): Promise<Map<string, number>> {
    if (!userId || trackIds.length === 0) {
        return new Map<string, number>();
    }

    const uniqueTrackIds = Array.from(
        new Set(
            trackIds.filter(
                (trackId): trackId is string =>
                    typeof trackId === "string" && trackId.length > 0
            )
        )
    );
    if (uniqueTrackIds.length === 0) {
        return new Map<string, number>();
    }

    const [likedEntries, dislikedEntries] = await Promise.all([
        prisma.likedTrack.findMany({
            where: {
                userId,
                trackId: { in: uniqueTrackIds },
            },
            select: {
                trackId: true,
                likedAt: true,
            },
        }),
        prisma.dislikedEntity.findMany({
            where: {
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: { in: uniqueTrackIds },
            },
            select: {
                entityId: true,
                dislikedAt: true,
            },
        }),
    ]);

    const likedByTrackId = new Map<string, Date>();
    for (const entry of likedEntries) {
        likedByTrackId.set(entry.trackId, entry.likedAt);
    }

    const dislikedByTrackId = new Map<string, Date>();
    for (const entry of dislikedEntries) {
        dislikedByTrackId.set(entry.entityId, entry.dislikedAt);
    }

    const scoreMap = new Map<string, number>();
    for (const trackId of uniqueTrackIds) {
        const resolved = resolveTrackPreference({
            likedAt: likedByTrackId.get(trackId) ?? null,
            dislikedAt: dislikedByTrackId.get(trackId) ?? null,
        });
        if (resolved.score !== 0) {
            scoreMap.set(trackId, resolved.score);
        }
    }

    return scoreMap;
}

/**
 * @openapi
 * /api/vibe/map:
 *   get:
 *     summary: Get vibe map projection data
 *     description: Returns cached or computed 2D projection data for tracks with CLAP embeddings.
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: 2D vibe map projection payload
 *       401:
 *         description: Not authenticated
 */
router.get("/map", requireAuth, async (_req, res) => {
    try {
        const mapData = await computeMapProjection();
        res.json(mapData);
    } catch (error: any) {
        logger.error("Vibe map error:", error);
        res.status(500).json({ error: "Failed to compute map projection" });
    }
});

/**
 * Fetch a single track's CLAP embedding from pgvector.
 */
async function fetchTrackEmbedding(trackId: string): Promise<number[] | null> {
    const rows = await prisma.$queryRaw<{ embedding: string }[]>`
        SELECT embedding::text FROM track_embeddings WHERE track_id = ${trackId} LIMIT 1
    `;
    if (!rows.length) return null;
    return parseEmbedding(rows[0].embedding);
}

/**
 * Linearly interpolate between two embedding vectors.
 */
function lerpEmbedding(a: number[], b: number[], t: number): number[] {
    return a.map((v, i) => v * (1 - t) + b[i] * t);
}

/**
 * Weighted average of multiple embeddings.
 */
function blendEmbeddings(
    embeddings: number[][],
    weights: number[]
): number[] {
    const dim = embeddings[0].length;
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const result = new Array<number>(dim).fill(0);
    for (let i = 0; i < embeddings.length; i++) {
        const w = weights[i] / totalWeight;
        for (let d = 0; d < dim; d++) {
            result[d] += embeddings[i][d] * w;
        }
    }
    return result;
}

interface NearestTrackRow {
    id: string;
    title: string;
    distance: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
    energy: number | null;
    valence: number | null;
    danceability: number | null;
    arousal: number | null;
}

async function findNearestToEmbedding(
    embedding: number[],
    limit: number,
    excludeIds: string[] = []
): Promise<NearestTrackRow[]> {
    if (excludeIds.length > 0) {
        return runAnnQuery<NearestTrackRow[]>(Prisma.sql`
            SELECT
                t.id, t.title,
                te.embedding <=> ${embedding}::vector AS distance,
                a.id AS "albumId", a.title AS "albumTitle", a."coverUrl" AS "albumCoverUrl",
                ar.id AS "artistId", ar.name AS "artistName",
                t.energy, t.valence, t.danceability, t.arousal
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE te.track_id != ALL(${excludeIds}::text[])
            ORDER BY te.embedding <=> ${embedding}::vector
            LIMIT ${limit}
        `);
    }
    return runAnnQuery<NearestTrackRow[]>(Prisma.sql`
        SELECT
            t.id, t.title,
            te.embedding <=> ${embedding}::vector AS distance,
            a.id AS "albumId", a.title AS "albumTitle", a."coverUrl" AS "albumCoverUrl",
            ar.id AS "artistId", ar.name AS "artistName",
            t.energy, t.valence, t.danceability, t.arousal
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        ORDER BY te.embedding <=> ${embedding}::vector
        LIMIT ${limit}
    `);
}

function formatNearestTrack(row: NearestTrackRow) {
    return {
        id: row.id,
        title: row.title,
        distance: row.distance,
        similarity: Math.max(0, 1 - row.distance / 2),
        album: { id: row.albumId, title: row.albumTitle, coverUrl: row.albumCoverUrl },
        artist: { id: row.artistId, name: row.artistName },
        // Mirrors GET /api/vibe/similar/:trackId's audioFeatures shape so the
        // map/journey/path UI can render the same energy/valence/danceability/
        // arousal readout for every track surface, not just similar-tracks.
        audioFeatures: {
            energy: row.energy,
            valence: row.valence,
            danceability: row.danceability,
            arousal: row.arousal,
        },
    };
}

/**
 * Walk from a starting embedding toward a target embedding, one interpolation
 * step at a time, picking the nearest not-yet-used track at each step. Shared
 * by /path (walk between two known tracks) and /journey (walk toward a track
 * or a mood centroid) so the two never drift out of sync.
 */
async function walkEmbeddingSteps(
    fromEmbed: number[],
    targetEmbed: number[],
    tValues: number[],
    initialExcludeIds: string[]
): Promise<ReturnType<typeof formatNearestTrack>[]> {
    const usedIds = new Set(initialExcludeIds);
    const stepResults: ReturnType<typeof formatNearestTrack>[] = [];

    // Deliberately sequential (not Promise.all'd): each step's exclusion set
    // (`usedIds`) accumulates the track picked by every prior step, so step N+1
    // must see step N's pick before it queries or it can re-offer an
    // already-used track (or two steps could double-book the same nearest
    // neighbor). This is an intentional intra-journey dedup dependency, not an
    // accidental N+1 — parallelizing these queries would break it.
    for (const t of tValues) {
        const interpolated = lerpEmbedding(fromEmbed, targetEmbed, t);
        const nearest = await findNearestToEmbedding(
            interpolated,
            5,
            Array.from(usedIds)
        );
        if (nearest.length > 0) {
            const pick = nearest[0];
            usedIds.add(pick.id);
            stepResults.push(formatNearestTrack(pick));
        }
    }

    return stepResults;
}

/**
 * @openapi
 * /api/vibe/path:
 *   get:
 *     summary: Find a musical path between two tracks
 *     description: Interpolates through CLAP embedding space to find intermediate tracks forming a smooth journey from one track to another.
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema:
 *           type: string
 *         description: Starting track ID
 *       - in: query
 *         name: to
 *         required: true
 *         schema:
 *           type: string
 *         description: Ending track ID
 *       - in: query
 *         name: steps
 *         schema:
 *           type: integer
 *           default: 5
 *           minimum: 1
 *           maximum: 20
 *         description: Number of intermediate steps
 *     responses:
 *       200:
 *         description: Ordered list of intermediate tracks
 *       400:
 *         description: Missing from or to track IDs
 *       404:
 *         description: One or both tracks lack embeddings
 *       401:
 *         description: Not authenticated
 */
router.get("/path", requireAuth, async (req, res) => {
    try {
        const fromId = req.query.from as string;
        const toId = req.query.to as string;

        if (!fromId || !toId) {
            return res
                .status(400)
                .json({ error: "Both 'from' and 'to' track IDs are required" });
        }

        const steps = Math.min(
            Math.max(1, parseInt(req.query.steps as string) || 5),
            20
        );

        const [fromEmbed, toEmbed] = await Promise.all([
            fetchTrackEmbedding(fromId),
            fetchTrackEmbedding(toId),
        ]);

        if (!fromEmbed) {
            return res
                .status(404)
                .json({ error: "Starting track has no embedding" });
        }
        if (!toEmbed) {
            return res
                .status(404)
                .json({ error: "Ending track has no embedding" });
        }

        const tValues = Array.from(
            { length: steps },
            (_, idx) => (idx + 1) / (steps + 1)
        );
        const stepResults = await walkEmbeddingSteps(
            fromEmbed,
            toEmbed,
            tValues,
            [fromId, toId]
        );

        res.json({ from: fromId, to: toId, steps: stepResults });
    } catch (error: any) {
        logger.error("Vibe path error:", error);
        res.status(500).json({ error: "Failed to compute song path" });
    }
});

const MIN_JOURNEY_STEPS = 2;
const MAX_JOURNEY_STEPS = 20;
const DEFAULT_JOURNEY_STEPS = 8;
const MAX_JOURNEY_EXCLUDE_TRACK_IDS = 200;
const MIN_MOOD_BUCKET_TRACKS = 5;
const MOOD_BUCKET_POOL_LIMIT = 50;

interface MoodBucketEmbeddingRow {
    trackId: string;
    embedding: string;
}

/**
 * @openapi
 * /api/vibe/journey:
 *   post:
 *     summary: Walk from a track toward a destination track or mood
 *     description: Interpolates through CLAP embedding space from a starting track toward either a destination track or the centroid of a mood bucket, returning an ordered list of waypoint tracks.
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fromTrackId
 *             properties:
 *               fromTrackId:
 *                 type: string
 *                 description: Starting track ID
 *               toTrackId:
 *                 type: string
 *                 description: Destination track ID (exactly one of toTrackId/mood is required)
 *               mood:
 *                 type: string
 *                 enum: [happy, sad, chill, energetic, party, focus, melancholy, aggressive, acoustic]
 *                 description: Destination mood bucket (exactly one of toTrackId/mood is required)
 *               steps:
 *                 type: integer
 *                 default: 8
 *                 minimum: 2
 *                 maximum: 20
 *                 description: Number of waypoints to return
 *               excludeTrackIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 maxItems: 200
 *                 description: Track IDs to exclude from waypoints
 *     responses:
 *       200:
 *         description: Ordered list of waypoint tracks toward the destination track or mood centroid
 *       400:
 *         description: Missing fromTrackId, not exactly one of toTrackId/mood, invalid mood, or excludeTrackIds invalid/too long
 *       404:
 *         description: Starting track has no embedding, destination track has no embedding, destination track was not found (e.g. deleted between the embedding lookup and the track fetch), or the mood has fewer than 5 embedded tracks
 *       401:
 *         description: Not authenticated
 */
router.post("/journey", requireAuth, async (req, res) => {
    try {
        const { fromTrackId, toTrackId, mood, steps: requestedSteps, excludeTrackIds } = req.body ?? {};

        if (typeof fromTrackId !== "string" || !fromTrackId) {
            return res.status(400).json({ error: "fromTrackId is required" });
        }

        const hasToTrackId = typeof toTrackId === "string" && toTrackId.length > 0;
        const hasMood = typeof mood === "string" && mood.length > 0;
        if (hasToTrackId === hasMood) {
            return res.status(400).json({
                error: "Provide exactly one of toTrackId or mood",
            });
        }

        if (hasMood && !VALID_MOODS.includes(mood as MoodType)) {
            return res.status(400).json({
                error: `Invalid mood. Must be one of: ${VALID_MOODS.join(", ")}`,
            });
        }

        if (hasToTrackId && toTrackId === fromTrackId) {
            return res.status(400).json({
                error: "Origin and destination are the same track",
            });
        }

        let excludeIds: string[] = [];
        if (excludeTrackIds !== undefined) {
            if (
                !Array.isArray(excludeTrackIds) ||
                excludeTrackIds.some((id: unknown) => typeof id !== "string")
            ) {
                return res.status(400).json({
                    error: "excludeTrackIds must be an array of strings",
                });
            }
            if (excludeTrackIds.length > MAX_JOURNEY_EXCLUDE_TRACK_IDS) {
                return res.status(400).json({
                    error: `excludeTrackIds cannot exceed ${MAX_JOURNEY_EXCLUDE_TRACK_IDS} entries`,
                });
            }
            excludeIds = excludeTrackIds;
        }

        let steps = DEFAULT_JOURNEY_STEPS;
        if (requestedSteps !== undefined) {
            if (!Number.isInteger(requestedSteps)) {
                return res.status(400).json({ error: "steps must be an integer" });
            }
            steps = Math.min(
                Math.max(MIN_JOURNEY_STEPS, requestedSteps),
                MAX_JOURNEY_STEPS
            );
        }

        const fromEmbed = await fetchTrackEmbedding(fromTrackId);
        if (!fromEmbed) {
            return res
                .status(404)
                .json({ error: "Starting track has no embedding" });
        }

        let mode: "track" | "mood";
        let targetEmbed: number[];
        let target: { trackId: string; title: string } | { mood: string; label: string };
        let destinationWaypoint: ReturnType<typeof formatNearestTrack> | null = null;

        if (hasToTrackId) {
            mode = "track";
            const toEmbed = await fetchTrackEmbedding(toTrackId);
            if (!toEmbed) {
                return res
                    .status(404)
                    .json({ error: "Destination track has no embedding" });
            }
            targetEmbed = toEmbed;

            const destinationTrack = await prisma.track.findUnique({
                where: { id: toTrackId },
                include: { album: { include: { artist: true } } },
            });
            if (!destinationTrack) {
                // TOCTOU: the track_embeddings row fetched above (fetchTrackEmbedding
                // succeeded) can outlive its Track row for a moment if the track is
                // deleted between the two queries — TrackEmbedding has onDelete:
                // Cascade, so this is a genuine race window, not a stale-row bug.
                // Without this guard, destinationWaypoint stays null and the route
                // silently drops the destination instead of ever reaching it.
                return res
                    .status(404)
                    .json({ error: "Destination track not found" });
            }
            target = { trackId: toTrackId, title: destinationTrack.title };
            destinationWaypoint = {
                id: destinationTrack.id,
                title: destinationTrack.title,
                distance: 0,
                similarity: 1,
                album: {
                    id: destinationTrack.album.id,
                    title: destinationTrack.album.title,
                    coverUrl: destinationTrack.album.coverUrl,
                },
                artist: {
                    id: destinationTrack.album.artist.id,
                    name: destinationTrack.album.artist.name,
                },
                audioFeatures: {
                    energy: destinationTrack.energy,
                    valence: destinationTrack.valence,
                    danceability: destinationTrack.danceability,
                    arousal: destinationTrack.arousal,
                },
            };
        } else {
            mode = "mood";
            const moodKey = mood as MoodType;

            // Blessed raw-SQL join beside fetchTrackEmbedding/findNearestToEmbedding:
            // pulls the top-scoring embedded tracks in this mood bucket so we can
            // average their vectors into a target centroid via blendEmbeddings.
            const moodTracks = await prisma.$queryRaw<MoodBucketEmbeddingRow[]>`
                SELECT mb."trackId", te.embedding::text AS embedding
                FROM "MoodBucket" mb
                JOIN track_embeddings te ON te.track_id = mb."trackId"
                WHERE mb.mood = ${moodKey} AND mb.score >= ${MOOD_BUCKET_MIN_SCORE}
                ORDER BY mb.score DESC
                LIMIT ${MOOD_BUCKET_POOL_LIMIT}
            `;

            if (moodTracks.length < MIN_MOOD_BUCKET_TRACKS) {
                return res.status(404).json({
                    error: `Mood '${moodKey}' does not have enough embedded tracks for a journey`,
                });
            }

            const moodEmbeddings = moodTracks.map((row) => parseEmbedding(row.embedding));
            targetEmbed = blendEmbeddings(
                moodEmbeddings,
                moodEmbeddings.map(() => 1)
            );
            target = { mood: moodKey, label: MOOD_CONFIG[moodKey].name };
        }

        let waypoints: ReturnType<typeof formatNearestTrack>[];
        if (mode === "track") {
            // Walk only the intermediate steps (t = i/steps for i in 1..steps-1);
            // the destination itself is appended as the literal final waypoint
            // below, so it is never re-derived from a possibly-drifted ANN query.
            const tValues = Array.from(
                { length: steps - 1 },
                (_, idx) => (idx + 1) / steps
            );
            const intermediate = await walkEmbeddingSteps(
                fromEmbed,
                targetEmbed,
                tValues,
                [fromTrackId, toTrackId, ...excludeIds]
            );
            waypoints = destinationWaypoint
                ? [...intermediate, destinationWaypoint]
                : intermediate;
        } else {
            const tValues = Array.from({ length: steps }, (_, idx) => (idx + 1) / steps);
            waypoints = await walkEmbeddingSteps(
                fromEmbed,
                targetEmbed,
                tValues,
                [fromTrackId, ...excludeIds]
            );
        }

        res.json({ mode, target, waypoints });
    } catch (error: any) {
        logger.error("Vibe journey error:", error);
        res.status(500).json({ error: "Failed to compute vibe journey" });
    }
});

/**
 * @openapi
 * /api/vibe/moods:
 *   get:
 *     summary: List moods usable as journey/drift anchors
 *     description: Returns each canonical mood with the count of qualifying bucket tracks that also have a CLAP embedding, so the UI can enable/disable mood-based journey targets.
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Moods with embedded-track counts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   mood:
 *                     type: string
 *                   trackCount:
 *                     type: integer
 *       401:
 *         description: Not authenticated
 */
router.get("/moods", requireAuth, async (_req, res) => {
    try {
        const grouped = await prisma.moodBucket.groupBy({
            by: ["mood"],
            where: {
                score: { gte: MOOD_BUCKET_MIN_SCORE },
                track: { embedding: { isNot: null } },
            },
            _count: { _all: true },
        });

        const countsByMood = new Map(
            grouped.map((row) => [row.mood, row._count._all])
        );

        res.json(
            VALID_MOODS.map((mood) => ({
                mood,
                trackCount: countsByMood.get(mood) ?? 0,
            }))
        );
    } catch (error: any) {
        logger.error("Vibe moods error:", error);
        res.status(500).json({ error: "Failed to list moods" });
    }
});

/**
 * @openapi
 * /api/vibe/alchemy:
 *   post:
 *     summary: Blend multiple tracks to discover new vibes
 *     description: Combines CLAP embeddings from multiple ingredient tracks with optional weights to find tracks matching the blended vibe.
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - trackIds
 *             properties:
 *               trackIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 minItems: 2
 *                 maxItems: 10
 *                 description: Track IDs to blend
 *               weights:
 *                 type: array
 *                 items:
 *                   type: number
 *                 description: Optional per-track weights (defaults to equal)
 *               limit:
 *                 type: integer
 *                 default: 20
 *                 minimum: 1
 *                 maximum: 100
 *     responses:
 *       200:
 *         description: Tracks matching the blended vibe
 *       400:
 *         description: Fewer than 2 or more than 10 track IDs provided, or weights do not sum to a positive value
 *       404:
 *         description: One or more ingredient tracks lack embeddings
 *       401:
 *         description: Not authenticated
 */
router.post("/alchemy", requireAuth, async (req, res) => {
    try {
        const { trackIds, weights, limit: requestedLimit } = req.body;

        if (!Array.isArray(trackIds) || trackIds.length < 2) {
            return res
                .status(400)
                .json({ error: "At least 2 track IDs are required for alchemy" });
        }

        if (trackIds.length > 10) {
            return res
                .status(400)
                .json({ error: "Maximum 10 ingredient tracks allowed" });
        }

        const limit = Math.min(
            Math.max(1, requestedLimit || 20),
            100
        );

        const embeddings: number[][] = [];
        for (const tid of trackIds) {
            const emb = await fetchTrackEmbedding(tid);
            if (!emb) {
                return res
                    .status(404)
                    .json({ error: `Track ${tid} has no embedding` });
            }
            embeddings.push(emb);
        }

        const effectiveWeights = Array.isArray(weights) && weights.length === trackIds.length
            ? weights.map((w: number) => Math.max(0, w))
            : trackIds.map(() => 1);

        // Flooring negatives at 0 above still allows every weight to be 0 (e.g.
        // [0, 0]), which makes blendEmbeddings divide by a zero totalWeight and
        // fill the blended vector with NaN — pgvector rejects a NaN-bearing
        // vector, so that request would otherwise reach findNearestToEmbedding
        // and surface as an opaque 500. Reject it explicitly instead.
        const weightSum = effectiveWeights.reduce((s, w) => s + w, 0);
        if (!Number.isFinite(weightSum) || weightSum <= 0) {
            return res
                .status(400)
                .json({ error: "weights must sum to a positive value" });
        }

        const blended = blendEmbeddings(embeddings, effectiveWeights);
        const nearest = await findNearestToEmbedding(blended, limit, trackIds);

        res.json({
            ingredients: trackIds,
            weights: effectiveWeights,
            tracks: nearest.map(formatNearestTrack),
        });
    } catch (error: any) {
        logger.error("Vibe alchemy error:", error);
        res.status(500).json({ error: "Failed to compute alchemy blend" });
    }
});

/**
 * @openapi
 * /api/vibe/similar/{trackId}:
 *   get:
 *     summary: Find similar tracks
 *     description: Returns tracks similar to the given track using hybrid similarity (CLAP embeddings + audio features). Results are weighted by user track preferences (likes/dislikes).
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: Source track ID to find similar tracks for
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           minimum: 1
 *           maximum: 100
 *         description: Maximum number of similar tracks to return
 *     responses:
 *       200:
 *         description: Similar tracks with similarity scores and audio features
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sourceTrackId:
 *                   type: string
 *                 sourceFeatures:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     energy:
 *                       type: number
 *                     valence:
 *                       type: number
 *                     danceability:
 *                       type: number
 *                     arousal:
 *                       type: number
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       title:
 *                         type: string
 *                       duration:
 *                         type: number
 *                       distance:
 *                         type: number
 *                       similarity:
 *                         type: number
 *                       album:
 *                         type: object
 *                       artist:
 *                         type: object
 *                       audioFeatures:
 *                         type: object
 *       404:
 *         description: No similar tracks found or track not analyzed
 *       401:
 *         description: Not authenticated
 */
const MIXER_CACHE_TTL_SECONDS = 3600;

function roundSim(value: number): number {
    return Math.round(value * 10000) / 10000;
}

/**
 * @openapi
 * /api/vibe/mixer/{trackId}:
 *   get:
 *     summary: Per-track similarity components against a seed track
 *     description: >
 *       Returns CLAP and lyric-semantic similarity of EVERY track in the
 *       cached vibe-map projection against the seed track, as arrays
 *       index-aligned to the projection's `tracks` order (the client blends
 *       them with its local weights for live map recoloring). Exact scans,
 *       not ANN — bounded by the 15k projection cap. The response's
 *       `computedAt`/`count` must match the client's map payload or the
 *       client must refetch the map first.
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Index-aligned clapSim/lyricSim arrays (null where missing)
 *       404:
 *         description: Seed track has no CLAP embedding
 *       409:
 *         description: No cached map projection exists yet — load the map first
 *       401:
 *         description: Not authenticated
 */
router.get<{ trackId: string }>("/mixer/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;

        const projection = await getCachedProjection();
        if (!projection || projection.tracks.length === 0) {
            return res.status(409).json({
                error: "No cached map projection",
                stale: true,
                message: "Load the vibe map first, then request mixer components",
            });
        }

        const cacheKey = `vibe:mixer:v1:${trackId}:${projection.computedAt}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return res.json(JSON.parse(cached));
            }
        } catch {
            // cache is best-effort
        }

        const seedEmbedding = await fetchTrackEmbedding(trackId);
        if (!seedEmbedding) {
            return res.status(404).json({
                error: "Track has no vibe embedding",
                message: "This track may not have been analyzed yet",
            });
        }

        const ids = projection.tracks.map((track) => track.id);

        // Exact scans (no ANN, no ivfflat recall concerns): 15k × 512/768-D
        // dot products are tens of ms in Postgres. Deliberately NOT filtered
        // to the projection's ids: a `= ANY(<15k ids>)` bind ships ~390KB of
        // parameters per scan and costs ~1.5× the plain scan on the production
        // pg-driver path (wire-timed 36ms vs 25ms median on the same corpus),
        // degrading to ~73ms under a generic plan — a cliff the unfiltered
        // shape can't hit. Scanning every embedding and aligning through the
        // id maps below yields an identical response — rows for tracks
        // outside the projection simply never get read.
        const clapRows = await prisma.$queryRaw<{ track_id: string; sim: number }[]>`
            SELECT track_id, 1 - (embedding <=> ${seedEmbedding}::vector) as sim
            FROM track_embeddings
        `;

        // Lyric similarity only when the seed itself is lyric-analyzed and
        // non-instrumental; candidates are filtered the same way so a null
        // in lyricSim always means "lyric dials don't apply to this pair".
        const seedLyric = await prisma.$queryRaw<{ embedding: string }[]>`
            SELECT tle.embedding::text
            FROM track_lyric_embeddings tle
            JOIN "TrackLyrics" tl ON tl."trackId" = tle.track_id
            WHERE tle.track_id = ${trackId}
                AND tl."analysisStatus" = 'completed'
                AND tl."isInstrumental" = false
            LIMIT 1
        `;

        let lyricRows: { track_id: string; sim: number }[] = [];
        if (seedLyric.length > 0) {
            const seedLyricEmbedding = parseEmbedding(seedLyric[0].embedding);
            lyricRows = await prisma.$queryRaw<{ track_id: string; sim: number }[]>`
                SELECT tle.track_id, 1 - (tle.embedding <=> ${seedLyricEmbedding}::vector) as sim
                FROM track_lyric_embeddings tle
                JOIN "TrackLyrics" tl ON tl."trackId" = tle.track_id
                WHERE tl."analysisStatus" = 'completed'
                    AND tl."isInstrumental" = false
            `;
        }

        const clapById = new Map(clapRows.map((row) => [row.track_id, row.sim]));
        const lyricById = new Map(lyricRows.map((row) => [row.track_id, row.sim]));

        const response = {
            seedId: trackId,
            computedAt: projection.computedAt,
            count: ids.length,
            clapSim: ids.map((id) => {
                const sim = clapById.get(id);
                return sim === undefined ? null : roundSim(sim);
            }),
            lyricSim: ids.map((id) => {
                const sim = lyricById.get(id);
                return sim === undefined ? null : roundSim(sim);
            }),
        };

        try {
            await redisClient.setEx(
                cacheKey,
                MIXER_CACHE_TTL_SECONDS,
                JSON.stringify(response)
            );
        } catch {
            // cache is best-effort
        }

        res.json(response);
    } catch (error) {
        logger.error("Vibe mixer components error:", error);
        res.status(500).json({ error: "Failed to compute mixer components" });
    }
});

/** Resolve a user's stored similarity weights (defaults when unset/invalid). */
async function loadUserSimilarityWeights(userId: string | undefined) {
    if (!userId) return { ...DEFAULT_SIMILARITY_WEIGHTS };
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { similarityWeights: true },
    });
    return resolveUserWeights(user?.similarityWeights);
}

type XrayRow = {
    a_id: string; a_title: string; a_artist: string; a_album_id: string | null; a_cover_url: string | null;
    a_energy: number | null; a_valence: number | null; a_bpm: number | null;
    a_danceability: number | null; a_acousticness: number | null; a_instrumentalness: number | null;
    a_key: string | null; a_key_scale: string | null;
    a_sentiment: number | null; a_lexical: number | null; a_reading: number | null;
    a_lyric_status: string | null; a_lyric_instrumental: boolean | null;
    b_id: string; b_title: string; b_artist: string; b_album_id: string | null; b_cover_url: string | null;
    b_energy: number | null; b_valence: number | null; b_bpm: number | null;
    b_danceability: number | null; b_acousticness: number | null; b_instrumentalness: number | null;
    b_key: string | null; b_key_scale: string | null;
    b_sentiment: number | null; b_lexical: number | null; b_reading: number | null;
    b_lyric_status: string | null; b_lyric_instrumental: boolean | null;
    clap_sim: number | null;
    lyric_sim: number | null;
    bpm_sim: number;
    key_sim: number;
};

// §core-math closeness (mirrors frontend simMath.ts and the scoring SQL)
const xrayFeatureCloseness = (a: number | null, b: number | null) =>
    1 - Math.abs((a ?? 0.5) - (b ?? 0.5));
const xraySentimentCloseness = (a: number, b: number) => 1 - Math.abs(a - b) / 2;
const xrayLexicalCloseness = (a: number, b: number) =>
    1 - Math.abs(Math.min(a, 120) - Math.min(b, 120)) / 120;
const xrayReadingCloseness = (a: number, b: number) =>
    1 - Math.min(Math.abs(a - b), 12) / 12;

function xrayLyricStatus(
    status: string | null,
    instrumental: boolean | null
): "analyzed" | "instrumental" | "unknown" {
    if (status === "completed" && instrumental !== true) return "analyzed";
    if (status === "instrumental" || instrumental === true) return "instrumental";
    return "unknown";
}

/**
 * @openapi
 * /api/vibe/xray:
 *   get:
 *     summary: Component-by-component comparison of two tracks
 *     description: >
 *       The "why do these two songs (not) match" breakdown: true CLAP cosine
 *       similarity, each audio-feature similarity, key relationship inputs,
 *       lyric similarities and scalar gaps, shared neighbors (under the
 *       requester's weight mix), and an overall blended score. Machine-
 *       readable — the client composes Camelot labels and verdict sentences.
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: a
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: b
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Full pairwise component breakdown
 *       400:
 *         description: Missing or identical track ids
 *       404:
 *         description: One or both tracks not found
 *       401:
 *         description: Not authenticated
 */
router.get("/xray", requireAuth, async (req, res) => {
    try {
        const a = typeof req.query.a === "string" ? req.query.a : "";
        const b = typeof req.query.b === "string" ? req.query.b : "";
        if (!a || !b) {
            return res.status(400).json({ error: "Both a and b track ids are required" });
        }
        if (a === b) {
            return res.status(400).json({ error: "Pick two different tracks to compare" });
        }

        const rows = await prisma.$queryRaw<XrayRow[]>`
            WITH side_a AS (
                SELECT t.id, t.title, ar.name as artist, t."albumId", al."coverUrl",
                    t.energy, t.valence, t.bpm, t.danceability, t.acousticness,
                    t.instrumentalness, t.key, t."keyScale",
                    te.embedding as clap_embedding,
                    tle.embedding as lyric_embedding,
                    tl.sentiment, tl."lexicalDiversity", tl."readingLevel",
                    tl."analysisStatus" as lyric_status,
                    tl."isInstrumental" as lyric_instrumental
                FROM "Track" t
                JOIN "Album" al ON t."albumId" = al.id
                JOIN "Artist" ar ON al."artistId" = ar.id
                LEFT JOIN track_embeddings te ON te.track_id = t.id
                LEFT JOIN track_lyric_embeddings tle ON tle.track_id = t.id
                LEFT JOIN "TrackLyrics" tl ON tl."trackId" = t.id
                WHERE t.id = ${a}
            ),
            side_b AS (
                SELECT t.id, t.title, ar.name as artist, t."albumId", al."coverUrl",
                    t.energy, t.valence, t.bpm, t.danceability, t.acousticness,
                    t.instrumentalness, t.key, t."keyScale",
                    te.embedding as clap_embedding,
                    tle.embedding as lyric_embedding,
                    tl.sentiment, tl."lexicalDiversity", tl."readingLevel",
                    tl."analysisStatus" as lyric_status,
                    tl."isInstrumental" as lyric_instrumental
                FROM "Track" t
                JOIN "Album" al ON t."albumId" = al.id
                JOIN "Artist" ar ON al."artistId" = ar.id
                LEFT JOIN track_embeddings te ON te.track_id = t.id
                LEFT JOIN track_lyric_embeddings tle ON tle.track_id = t.id
                LEFT JOIN "TrackLyrics" tl ON tl."trackId" = t.id
                WHERE t.id = ${b}
            )
            SELECT
                side_a.id as a_id, side_a.title as a_title, side_a.artist as a_artist,
                side_a."albumId" as a_album_id, side_a."coverUrl" as a_cover_url,
                side_a.energy as a_energy, side_a.valence as a_valence, side_a.bpm as a_bpm,
                side_a.danceability as a_danceability, side_a.acousticness as a_acousticness,
                side_a.instrumentalness as a_instrumentalness,
                side_a.key as a_key, side_a."keyScale" as a_key_scale,
                side_a.sentiment as a_sentiment, side_a."lexicalDiversity" as a_lexical,
                side_a."readingLevel" as a_reading,
                side_a.lyric_status as a_lyric_status, side_a.lyric_instrumental as a_lyric_instrumental,
                side_b.id as b_id, side_b.title as b_title, side_b.artist as b_artist,
                side_b."albumId" as b_album_id, side_b."coverUrl" as b_cover_url,
                side_b.energy as b_energy, side_b.valence as b_valence, side_b.bpm as b_bpm,
                side_b.danceability as b_danceability, side_b.acousticness as b_acousticness,
                side_b.instrumentalness as b_instrumentalness,
                side_b.key as b_key, side_b."keyScale" as b_key_scale,
                side_b.sentiment as b_sentiment, side_b."lexicalDiversity" as b_lexical,
                side_b."readingLevel" as b_reading,
                side_b.lyric_status as b_lyric_status, side_b.lyric_instrumental as b_lyric_instrumental,
                CASE WHEN side_a.clap_embedding IS NOT NULL AND side_b.clap_embedding IS NOT NULL
                    THEN 1 - (side_a.clap_embedding <=> side_b.clap_embedding) END as clap_sim,
                CASE WHEN side_a.lyric_embedding IS NOT NULL AND side_b.lyric_embedding IS NOT NULL
                    THEN 1 - (side_a.lyric_embedding <=> side_b.lyric_embedding) END as lyric_sim,
                bpm_similarity(side_a.bpm, side_b.bpm) as bpm_sim,
                key_similarity(side_a.key, side_a."keyScale", side_b.key, side_b."keyScale") as key_sim
            FROM side_a, side_b
        `;

        if (rows.length === 0) {
            return res.status(404).json({ error: "One or both tracks not found" });
        }
        const row = rows[0];

        const aLyricStatus = xrayLyricStatus(row.a_lyric_status, row.a_lyric_instrumental);
        const bLyricStatus = xrayLyricStatus(row.b_lyric_status, row.b_lyric_instrumental);
        const lyricsApply = aLyricStatus === "analyzed" && bLyricStatus === "analyzed";

        const features = [
            { key: "energy" as const, a: row.a_energy, b: row.b_energy, similarity: xrayFeatureCloseness(row.a_energy, row.b_energy) },
            { key: "valence" as const, a: row.a_valence, b: row.b_valence, similarity: xrayFeatureCloseness(row.a_valence, row.b_valence) },
            { key: "bpm" as const, a: row.a_bpm, b: row.b_bpm, similarity: row.bpm_sim },
            { key: "danceability" as const, a: row.a_danceability, b: row.b_danceability, similarity: xrayFeatureCloseness(row.a_danceability, row.b_danceability) },
            { key: "acousticness" as const, a: row.a_acousticness, b: row.b_acousticness, similarity: xrayFeatureCloseness(row.a_acousticness, row.b_acousticness) },
            { key: "instrumentalness" as const, a: row.a_instrumentalness, b: row.b_instrumentalness, similarity: xrayFeatureCloseness(row.a_instrumentalness, row.b_instrumentalness) },
        ];

        // Overall = the same §blend the mixer/scoring use, under the
        // requester's weights, so the headline number matches what the map
        // and /similar would say about this pair.
        const weights = await loadUserSimilarityWeights(req.user?.id);
        const { norm, lyricSum } = splitAndNormalize(weights);
        let num = 0;
        let den = 0;
        if (row.clap_sim != null) {
            num += norm.clap * Math.max(0, row.clap_sim);
            den += norm.clap;
        }
        num +=
            norm.energy * features[0].similarity +
            norm.valence * features[1].similarity +
            norm.bpm * row.bpm_sim +
            norm.danceability * features[3].similarity +
            norm.acousticness * features[4].similarity +
            norm.instrumentalness * features[5].similarity +
            norm.key * row.key_sim;
        den +=
            norm.energy + norm.valence + norm.bpm + norm.danceability +
            norm.acousticness + norm.instrumentalness + norm.key;
        const sentiment =
            lyricsApply && row.a_sentiment != null && row.b_sentiment != null
                ? { a: row.a_sentiment, b: row.b_sentiment, similarity: xraySentimentCloseness(row.a_sentiment, row.b_sentiment) }
                : null;
        const lexical =
            lyricsApply && row.a_lexical != null && row.b_lexical != null
                ? { a: row.a_lexical, b: row.b_lexical, similarity: xrayLexicalCloseness(row.a_lexical, row.b_lexical) }
                : null;
        const reading =
            lyricsApply && row.a_reading != null && row.b_reading != null
                ? { a: row.a_reading, b: row.b_reading, similarity: xrayReadingCloseness(row.a_reading, row.b_reading) }
                : null;
        const semanticSimilarity = lyricsApply && row.lyric_sim != null ? Math.max(0, row.lyric_sim) : null;
        if (lyricsApply && semanticSimilarity != null && sentiment) {
            num +=
                norm.lyricSemantic * semanticSimilarity +
                norm.lyricSentiment * sentiment.similarity +
                (lexical ? norm.lyricLexical * lexical.similarity : 0) +
                (reading ? norm.lyricReading * reading.similarity : 0);
            den += lyricSum;
        }
        const overallSimilarity = den > 0 ? num / den : 0;

        // Shared neighbors under the same weights (each capped list is small;
        // intersection preserves side-a ranking)
        const [neighborsA, neighborsB] = await Promise.all([
            findSimilarTracks(a, 25, weights),
            findSimilarTracks(b, 25, weights),
        ]);
        const bIds = new Set(neighborsB.map((t) => t.id));
        const sharedNeighbors = neighborsA
            .filter((t) => bIds.has(t.id) && t.id !== a && t.id !== b)
            .slice(0, 5)
            .map((t) => ({
                id: t.id,
                title: t.title,
                artist: t.artistName,
                albumId: t.albumId ?? null,
                coverUrl: t.albumCoverUrl ?? null,
            }));

        res.json({
            a: { id: row.a_id, title: row.a_title, artist: row.a_artist, albumId: row.a_album_id, coverUrl: row.a_cover_url },
            b: { id: row.b_id, title: row.b_title, artist: row.b_artist, albumId: row.b_album_id, coverUrl: row.b_cover_url },
            overall: {
                similarity: overallSimilarity,
                weights: isDefaultWeights(weights) ? "default" : "custom",
            },
            clap: { available: row.clap_sim != null, similarity: row.clap_sim },
            features,
            keys: {
                a: row.a_key ? { key: row.a_key, scale: row.a_key_scale } : null,
                b: row.b_key ? { key: row.b_key, scale: row.b_key_scale } : null,
                similarity: row.key_sim,
            },
            lyrics: {
                aStatus: aLyricStatus,
                bStatus: bLyricStatus,
                semanticSimilarity,
                sentiment,
                lexical,
                reading,
            },
            sharedNeighbors,
        });
    } catch (error) {
        logger.error("Vibe xray error:", error);
        res.status(500).json({ error: "Failed to compare tracks" });
    }
});

/**
 * @openapi
 * /api/vibe/weights:
 *   get:
 *     summary: Get the current user's similarity component weights
 *     description: Returns the user's weight-mixer settings for similarity scoring, falling back to the defaults when none are stored. isDefault indicates whether the stored mix equals the defaults.
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: The user's weights and whether they equal the defaults
 *       401:
 *         description: Not authenticated
 *   put:
 *     summary: Save the current user's similarity component weights
 *     description: Persists a full 12-component weight mix (each value 0..1, at least one > 0). Send null to reset to defaults. Applied to /api/vibe/similar scoring (and everything built on it, e.g. Travel) immediately.
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             nullable: true
 *             type: object
 *     responses:
 *       200:
 *         description: Weights saved (or reset when null was sent)
 *       400:
 *         description: Invalid weights payload
 *       401:
 *         description: Not authenticated
 */
router.get("/weights", requireAuth, async (req, res) => {
    try {
        const weights = await loadUserSimilarityWeights(req.user?.id);
        res.json({ weights, isDefault: isDefaultWeights(weights) });
    } catch (error) {
        logger.error("Get similarity weights error:", error);
        res.status(500).json({ error: "Failed to load similarity weights" });
    }
});

router.put("/weights", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;

        // null body = reset to defaults (clears the stored mix)
        if (req.body === null || req.body === undefined) {
            await prisma.user.update({
                where: { id: userId },
                data: { similarityWeights: Prisma.DbNull },
            });
            return res.json({
                weights: { ...DEFAULT_SIMILARITY_WEIGHTS },
                isDefault: true,
            });
        }

        const parsed = similarityWeightsSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: "Invalid similarity weights",
                details: parsed.error.issues,
            });
        }

        await prisma.user.update({
            where: { id: userId },
            data: { similarityWeights: parsed.data },
        });

        res.json({
            weights: parsed.data,
            isDefault: isDefaultWeights(parsed.data),
        });
    } catch (error) {
        logger.error("Save similarity weights error:", error);
        res.status(500).json({ error: "Failed to save similarity weights" });
    }
});

router.get<{ trackId: string }>("/similar/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;
        const userId = req.user?.id;
        const limit = Math.min(
            Math.max(1, parseInt(req.query.limit as string) || 20),
            100
        );

        const weights = await loadUserSimilarityWeights(userId);
        const tracks = await findSimilarTracks(trackId, limit, weights);
        let weightedTracks = tracks;

        const preferenceScores = await buildTrackPreferenceScoreMapForUser(
            userId,
            tracks.map((track) => track.id)
        );
        if (preferenceScores.size > 0) {
            const ordering = applyTrackPreferenceOrderBias(
                tracks.map((track) => track.id),
                preferenceScores
            );
            const trackById = new Map(tracks.map((track) => [track.id, track]));
            weightedTracks = ordering
                .map((id) => trackById.get(id))
                .filter((track): track is (typeof tracks)[number] => Boolean(track))
                .map((track) => ({
                    ...track,
                    similarity: Math.max(
                        0,
                        Math.min(
                            1,
                            applyTrackPreferenceSimilarityBias(
                                track.similarity,
                                preferenceScores.get(track.id) ?? 0
                            )
                        )
                    ),
                }));
            logger.debug(
                `[Vibe] Applied light preference weighting using ${preferenceScores.size} track preferences`
            );
        }

        if (weightedTracks.length === 0) {
            return res.status(404).json({
                error: "No similar tracks found",
                message: "This track may not have been analyzed yet, or no analyzer is running",
            });
        }

        // Fetch source track audio features for vibe match comparison
        const sourceTrack = await prisma.track.findUnique({
            where: { id: trackId },
            select: { energy: true, valence: true, danceability: true, arousal: true },
        });

        res.json({
            sourceTrackId: trackId,
            sourceFeatures: sourceTrack ? {
                energy: sourceTrack.energy,
                valence: sourceTrack.valence,
                danceability: sourceTrack.danceability,
                arousal: sourceTrack.arousal,
            } : null,
            tracks: weightedTracks.map((t) => ({
                id: t.id,
                title: t.title,
                duration: t.duration,
                distance: t.distance,
                similarity: t.similarity,
                album: {
                    id: t.albumId,
                    title: t.albumTitle,
                    coverUrl: t.albumCoverUrl,
                },
                artist: {
                    id: t.artistId,
                    name: t.artistName,
                },
                audioFeatures: {
                    energy: t.energy,
                    valence: t.valence,
                    danceability: t.danceability,
                    arousal: t.arousal,
                },
            })),
        });
    } catch (error: any) {
        logger.error("Hybrid similarity error:", error);
        res.status(500).json({ error: "Failed to find similar tracks" });
    }
});

// Convert CLAP cosine distance (0-2 range) to similarity percentage (0-1)
// distance 0 = identical, distance 1 = orthogonal, distance 2 = opposite
function distanceToSimilarity(distance: number): number {
    return Math.max(0, 1 - distance / 2);
}

// Minimum similarity threshold for search results
// 0.60 = 60% match, meaning distance <= 0.8
const MIN_SEARCH_SIMILARITY = 0.60;

interface TextEmbedResponsePayload {
    requestId: string;
    success: boolean;
    embedding: number[] | null;
    modelVersion: string;
    error?: string;
}

/**
 * @openapi
 * /api/vibe/search:
 *   post:
 *     summary: Search tracks by natural language vibe
 *     description: Searches for tracks using natural language text via CLAP text embeddings. Queries are expanded with a vocabulary of genre/mood terms and results are re-ranked using audio features.
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *             properties:
 *               query:
 *                 type: string
 *                 minLength: 2
 *                 description: Natural language search query (e.g. "chill acoustic guitar", "aggressive punk rock")
 *               limit:
 *                 type: integer
 *                 default: 20
 *                 minimum: 1
 *                 maximum: 100
 *               minSimilarity:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 1
 *                 default: 0.60
 *                 description: Minimum similarity threshold (0-1)
 *     responses:
 *       200:
 *         description: Matching tracks ranked by similarity
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 query:
 *                   type: string
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 minSimilarity:
 *                   type: number
 *                 totalAboveThreshold:
 *                   type: integer
 *                 debug:
 *                   type: object
 *       400:
 *         description: Query must be at least 2 characters
 *       401:
 *         description: Not authenticated
 *       504:
 *         description: Text embedding service unavailable
 */
router.post("/search", requireAuth, async (req, res) => {
    try {
        const { query, limit: requestedLimit, minSimilarity } = req.body;

        if (!query || typeof query !== "string" || query.trim().length < 2) {
            return res.status(400).json({
                error: "Query must be at least 2 characters",
            });
        }

        const limit = Math.min(
            Math.max(1, requestedLimit || 20),
            100
        );

        // Allow override but default to MIN_SEARCH_SIMILARITY
        const similarityThreshold = typeof minSimilarity === "number"
            ? Math.max(0, Math.min(1, minSimilarity))
            : MIN_SEARCH_SIMILARITY;

        // Convert similarity threshold to max distance
        // similarity = 1 - (distance / 2), so distance = 2 * (1 - similarity)
        const maxDistance = 2 * (1 - similarityThreshold);

        const requestId = randomUUID();
        const responseKey = `${TEXT_EMBED_RESPONSE_PREFIX}${requestId}`;
        const normalizedQuery = query.trim();

        try {
            // Queue text-embedding request via Redis Streams to ensure a single
            // CLAP replica claims and processes each request.
            await redisClient.xAdd(
                TEXT_EMBED_REQUEST_STREAM,
                "*",
                {
                    requestId,
                    text: normalizedQuery,
                    responseKey,
                }
            );

            // Wait for response from the CLAP worker.
            const response = await redisClient.blPop(
                responseKey,
                TEXT_EMBED_TIMEOUT_SECONDS
            );

            if (!response?.element) {
                throw new Error("Text embedding request timed out");
            }

            let payload: TextEmbedResponsePayload;
            try {
                payload = JSON.parse(response.element) as TextEmbedResponsePayload;
            } catch (_error) {
                throw new Error("Invalid response from analyzer");
            }

            if (payload.error) {
                throw new Error(payload.error);
            }

            if (!Array.isArray(payload.embedding)) {
                throw new Error("Invalid response from analyzer");
            }

            const textEmbedding = payload.embedding;

            // Query expansion with vocabulary
            const vocab = getVocabulary();
            let searchEmbedding = textEmbedding;
            let genreConfidence = 0;
            let matchedTerms: VocabTerm[] = [];

            if (vocab) {
                const expansion = expandQueryWithVocabulary(textEmbedding, normalizedQuery, vocab);
                searchEmbedding = expansion.embedding;
                genreConfidence = expansion.genreConfidence;
                matchedTerms = expansion.matchedTerms;

                logger.info(`[VIBE-SEARCH] Query "${normalizedQuery}" expanded with terms: ${matchedTerms.map(t => t.name).join(", ") || "none"}, genre confidence: ${(genreConfidence * 100).toFixed(0)}%`);
            }

            // Query for similar tracks using the (possibly expanded) embedding
            // Fetch more candidates for re-ranking (3x limit)
            // Filter by max distance to exclude poor matches
            const similarTracks = await runAnnQuery<TextSearchResult[]>(Prisma.sql`
                SELECT
                    t.id,
                    t.title,
                    t.duration,
                    t."trackNo",
                    te.embedding <=> ${searchEmbedding}::vector AS distance,
                    a.id as "albumId",
                    a.title as "albumTitle",
                    a."coverUrl" as "albumCoverUrl",
                    ar.id as "artistId",
                    ar.name as "artistName",
                    t.energy,
                    t.valence,
                    t.danceability,
                    t.acousticness,
                    t.instrumentalness,
                    t.arousal,
                    t.speechiness
                FROM track_embeddings te
                JOIN "Track" t ON te.track_id = t.id
                JOIN "Album" a ON t."albumId" = a.id
                JOIN "Artist" ar ON a."artistId" = ar.id
                WHERE te.embedding <=> ${searchEmbedding}::vector <= ${maxDistance}
                ORDER BY te.embedding <=> ${searchEmbedding}::vector
                LIMIT ${limit * 3}
            `);

            logger.info(`Vibe search "${normalizedQuery}": found ${similarTracks.length} candidates above ${Math.round(similarityThreshold * 100)}% similarity (max distance: ${maxDistance.toFixed(2)})`);

            // Re-rank using audio features if we have vocabulary matches
            let rankedTracks: typeof similarTracks | ReturnType<typeof rerankWithFeatures<TextSearchResult>> = similarTracks;
            if (vocab && matchedTerms.length > 0) {
                const reranked = rerankWithFeatures(similarTracks, matchedTerms, genreConfidence);
                rankedTracks = reranked.slice(0, limit);

                logger.info(`[VIBE-SEARCH] Re-ranked ${similarTracks.length} candidates, top result: ${rankedTracks[0]?.title || "none"}`);
            } else {
                rankedTracks = similarTracks.slice(0, limit);
            }

            // If we have results, log the similarity range
            if (rankedTracks.length > 0) {
                const first = rankedTracks[0];
                const last = rankedTracks[rankedTracks.length - 1];
                const bestSim = "finalScore" in first ? first.finalScore : distanceToSimilarity(first.distance);
                const worstSim = "finalScore" in last ? last.finalScore : distanceToSimilarity(last.distance);
                logger.info(`Vibe search similarity range: ${Math.round(bestSim * 100)}% - ${Math.round(worstSim * 100)}%`);
            }

            const tracks = rankedTracks.map((row) => ({
                id: row.id,
                title: row.title,
                duration: row.duration,
                trackNo: row.trackNo,
                distance: row.distance,
                similarity: "finalScore" in row ? row.finalScore : distanceToSimilarity(row.distance),
                album: {
                    id: row.albumId,
                    title: row.albumTitle,
                    coverUrl: row.albumCoverUrl,
                },
                artist: {
                    id: row.artistId,
                    name: row.artistName,
                },
            }));

            res.json({
                query: normalizedQuery,
                tracks,
                minSimilarity: similarityThreshold,
                totalAboveThreshold: tracks.length,
                debug: {
                    matchedTerms: matchedTerms.map(t => t.name),
                    genreConfidence,
                    featureWeight: matchedTerms.length > 0 ? 0.2 + (genreConfidence * 0.5) : 0
                }
            });
        } finally {
            await redisClient.del(responseKey).catch(() => {});
        }
    } catch (error: any) {
        logger.error("Vibe text search error:", error);
        if (error.message?.includes("timed out")) {
            return res.status(504).json({
                error: "Text embedding service unavailable",
                message: "The CLAP analyzer service did not respond in time",
            });
        }
        res.status(500).json({ error: "Failed to search tracks by vibe" });
    }
});

/**
 * @openapi
 * /api/vibe/status:
 *   get:
 *     summary: Get embedding analysis progress
 *     description: Returns statistics on how many tracks have been analyzed with CLAP embeddings, including total track count, embedded count, and completion percentage
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Embedding analysis progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalTracks:
 *                   type: integer
 *                 embeddedTracks:
 *                   type: integer
 *                 progress:
 *                   type: integer
 *                   description: Percentage of tracks analyzed (0-100)
 *                 isComplete:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        const totalTracks = await prisma.track.count();

        const embeddedTracks = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count FROM track_embeddings
        `;

        const embeddedCount = Number(embeddedTracks[0]?.count || 0);
        const progress = totalTracks > 0
            ? Math.round((embeddedCount / totalTracks) * 100)
            : 0;

        res.json({
            totalTracks,
            embeddedTracks: embeddedCount,
            progress,
            isComplete: embeddedCount >= totalTracks && totalTracks > 0,
        });
    } catch (error: any) {
        logger.error("Vibe status error:", error);
        res.status(500).json({ error: "Failed to get embedding status" });
    }
});

const CALIBRATION_SAMPLE_SIZE = 200;
const CALIBRATION_MIN_EMBEDDED_TRACKS = 10;
const CALIBRATION_CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h
const CALIBRATION_CACHE_KEY_PREFIX = "vibe:calibration:v1:";
const CALIBRATION_QUANTILE_COUNT = 101; // p0..p100 inclusive

interface CalibrationEmbeddingRow {
    embedding: string;
}

/**
 * True cosine distance between two vectors (1 - cosine similarity), matching
 * pgvector's `<=>` operator semantics used everywhere else in this file.
 * Embeddings aren't guaranteed unit-norm, so this normalizes explicitly
 * rather than assuming a dot product is already a cosine distance.
 */
function cosineDistance(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 1;
    return 1 - dot / denom;
}

/**
 * p0..p100 percentiles (101 values) of a already-sorted-ascending array,
 * via nearest-rank indexing. Monotonic non-decreasing by construction since
 * the source is sorted and the index is non-decreasing in p.
 */
function computeQuantiles(sortedAscending: number[]): number[] {
    const n = sortedAscending.length;
    const quantiles: number[] = [];
    for (let p = 0; p < CALIBRATION_QUANTILE_COUNT; p++) {
        const idx = Math.min(n - 1, Math.round((p / 100) * (n - 1)));
        quantiles.push(sortedAscending[idx]);
    }
    return quantiles;
}

/**
 * @openapi
 * /api/vibe/calibration:
 *   get:
 *     summary: Get library-calibrated pairwise-distance quantiles
 *     description: Returns the p0-p100 percentiles of pairwise CLAP cosine distance over a random sample of embedded tracks in this library, so the UI can express match strength as "closer than N% of random pairs in your library" instead of a fixed linear mapping that reads as inflated on libraries where unrelated tracks rarely exceed distance ~1.0.
 *     tags: [Vibe]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Distance quantiles, or an empty result when fewer than 10 tracks are embedded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sampleSize:
 *                   type: integer
 *                   description: Number of tracks sampled (0 when the library has fewer than 10 embedded tracks)
 *                 updatedAt:
 *                   type: string
 *                   description: ISO timestamp the sample was computed (omitted when sampleSize is 0)
 *                 quantiles:
 *                   type: array
 *                   items:
 *                     type: number
 *                   description: p0..p100 percentiles of pairwise cosine distance (101 values), empty when sampleSize is 0
 *       401:
 *         description: Not authenticated
 */
router.get("/calibration", requireAuth, async (_req, res) => {
    try {
        const embeddedCountRows = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count FROM track_embeddings
        `;
        const embeddedCount = Number(embeddedCountRows[0]?.count || 0);

        if (embeddedCount < CALIBRATION_MIN_EMBEDDED_TRACKS) {
            return res.json({ sampleSize: 0, quantiles: [] });
        }

        // Cache keyed on embeddedCount so it self-invalidates as the library
        // grows (a new track landing changes the key, forcing a recompute)
        // without needing an explicit invalidation hook.
        const cacheKey = `${CALIBRATION_CACHE_KEY_PREFIX}${embeddedCount}`;
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        // Blessed raw-SQL extension, same cluster as fetchTrackEmbedding/
        // findNearestToEmbedding above: `ORDER BY random()` has no pgvector
        // index to lean on and would be a bad idea as a per-request hot path,
        // but this is a one-shot calibration sample (<=200 rows) gated by the
        // 10-embedding floor above and cached 24h keyed on embeddedCount, not
        // a query that runs per page view.
        const rows = await prisma.$queryRaw<CalibrationEmbeddingRow[]>`
            SELECT te.embedding::text AS embedding
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            ORDER BY random()
            LIMIT ${CALIBRATION_SAMPLE_SIZE}
        `;

        const embeddings = rows.map((row) => parseEmbedding(row.embedding));
        const distances: number[] = [];
        for (let i = 0; i < embeddings.length; i++) {
            for (let j = i + 1; j < embeddings.length; j++) {
                distances.push(cosineDistance(embeddings[i], embeddings[j]));
            }
        }
        distances.sort((a, b) => a - b);

        const payload = {
            sampleSize: embeddings.length,
            updatedAt: new Date().toISOString(),
            quantiles: computeQuantiles(distances),
        };

        await redisClient.setEx(
            cacheKey,
            CALIBRATION_CACHE_TTL_SECONDS,
            JSON.stringify(payload)
        );

        res.json(payload);
    } catch (error: any) {
        logger.error("Vibe calibration error:", error);
        res.status(500).json({ error: "Failed to compute vibe calibration" });
    }
});

export default router;
