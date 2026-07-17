import { existsSync } from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { parseEmbedding } from "../utils/embedding";

const MIN_TRACKS_FOR_UMAP = 5;
const MAX_EMBEDDINGS = 15000;
// v5: payload diet — `moodScore` and the 7-float `moods` record dropped in
// favour of a single `moodHappy` scalar (the only key any client read), and
// x/y ship at 4dp (sub-pixel on any real screen). Undoes essentially all of
// v4's growth. Old keys orphan and expire via their 24h TTL — that is the
// whole invalidation story; never reuse a version once the shape changes.
// The `…:ids` companion (ORDERED, versioned by the shared computedAt —
// unlike the deleted v3-era unordered `…:track_ids` SET) is written beside
// the projection so index-aligned consumers (the mixer) can read ids +
// computedAt without parsing the multi-MB projection JSON per request.
const CACHE_KEY = "vibe:map:v5:projection";
const IDS_CACHE_KEY = "vibe:map:v5:ids";
const CACHE_TTL_SECONDS = 86400;
const UMAP_TIMEOUT_MS = 15 * 60 * 1000;
const UMAP_WARN_MS = 5 * 60 * 1000;

export interface VibeMapTrack {
    id: string;
    x: number;
    y: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    dominantMood: string;
    /** The one mood scalar clients consume (travel compass fallback). */
    moodHappy: number | null;
    energy: number | null;
    valence: number | null;
    // v4 fields (weight mixer / x-ray): audio features rounded to 3dp to
    // bound payload growth, plus lyric-analysis scalars where analyzed.
    bpm: number | null;
    danceability: number | null;
    acousticness: number | null;
    instrumentalness: number | null;
    key: string | null;
    keyScale: string | null;
    sentiment: number | null;
    lexicalDiversity: number | null;
    readingLevel: number | null;
    /** true only when lyric analysis completed and the track isn't instrumental */
    hasLyrics: boolean;
}

export interface VibeMapResponse {
    tracks: VibeMapTrack[];
    trackCount: number;
    sampled?: boolean;
    computedAt: string;
}

/**
 * Slim companion payload for consumers that only need the projection's id
 * order (the mixer): ids in EXACTLY the served `tracks` order, stamped with
 * the same `computedAt` so staleness checks against the client's map payload
 * keep working.
 */
export interface VibeMapIdsPayload {
    computedAt: string;
    trackCount: number;
    ids: string[];
}

type TrackRow = {
    track_id: string;
    title: string;
    artistName: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    energy: number | null;
    valence: number | null;
    moodHappy: number | null;
    moodSad: number | null;
    moodRelaxed: number | null;
    moodAggressive: number | null;
    moodParty: number | null;
    moodAcoustic: number | null;
    moodElectronic: number | null;
    bpm: number | null;
    danceability: number | null;
    acousticness: number | null;
    instrumentalness: number | null;
    key: string | null;
    keyScale: string | null;
    lyricSentiment: number | null;
    lyricLexicalDiversity: number | null;
    lyricReadingLevel: number | null;
    lyricsAnalysisStatus: string | null;
    lyricsInstrumental: boolean | null;
};

const MOOD_FIELDS = [
    "moodHappy",
    "moodSad",
    "moodRelaxed",
    "moodAggressive",
    "moodParty",
    "moodAcoustic",
    "moodElectronic",
] as const;

let computePromise: Promise<VibeMapResponse> | null = null;

function resolveUmapWorkerPath(): string {
    const candidatePaths = [
        path.join(__dirname, "../workers/umapWorker.js"),
        path.join(__dirname, "../workers/umapWorker.ts"),
    ];

    return candidatePaths.find((candidatePath) => existsSync(candidatePath)) ?? candidatePaths[0];
}

function getDominantMood(
    track: Record<string, unknown>
): { mood: string; score: number } {
    let best = { mood: "neutral", score: 0 };

    for (const field of MOOD_FIELDS) {
        const value = track[field] as number | null | undefined;
        if (value != null && value > best.score) {
            best = { mood: field, score: value };
        }
    }

    return best;
}

async function cacheResult(result: VibeMapResponse): Promise<void> {
    try {
        const idsPayload: VibeMapIdsPayload = {
            computedAt: result.computedAt,
            trackCount: result.trackCount,
            ids: result.tracks.map((track) => track.id),
        };
        // One MULTI so the pair can never half-land: a projection write that
        // succeeded while the ids write failed would leave a PREVIOUS
        // compute's ids key serving under a mismatched computedAt — a state
        // getCachedProjectionIds' missing-key fallback cannot detect.
        await redisClient
            .multi()
            .setEx(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(result))
            .setEx(IDS_CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(idsPayload))
            .exec();
    } catch (error) {
        logger.warn(
            "[VIBE-MAP] Failed to cache projection:",
            error instanceof Error ? error.message : String(error)
        );
    }
}

function round3(value: number | null): number | null {
    return value == null ? null : Math.round(value * 1000) / 1000;
}

function round4(value: number): number {
    return Math.round(value * 10000) / 10000;
}

function buildMapTrack(
    row: TrackRow,
    x: number,
    y: number
): VibeMapTrack {
    const dominant = getDominantMood(row as Record<string, unknown>);

    return {
        id: row.track_id,
        x: round4(x),
        y: round4(y),
        title: row.title,
        artist: row.artistName,
        artistId: row.artistId,
        albumId: row.albumId,
        coverUrl: row.coverUrl,
        dominantMood: dominant.mood,
        moodHappy: round3(row.moodHappy),
        energy: row.energy,
        valence: row.valence,
        bpm: round3(row.bpm),
        danceability: round3(row.danceability),
        acousticness: round3(row.acousticness),
        instrumentalness: round3(row.instrumentalness),
        key: row.key,
        keyScale: row.keyScale,
        sentiment: round3(row.lyricSentiment),
        lexicalDiversity: round3(row.lyricLexicalDiversity),
        readingLevel: round3(row.lyricReadingLevel),
        hasLyrics:
            row.lyricsAnalysisStatus === "completed" &&
            row.lyricsInstrumental !== true,
    };
}

async function buildCircularLayout(rows: Array<TrackRow & { embedding: string }>): Promise<VibeMapResponse> {
    const result: VibeMapResponse = {
        tracks: rows.map((row, index) => {
            const angle = (2 * Math.PI * index) / rows.length;
            return buildMapTrack(
                row,
                0.5 + 0.3 * Math.cos(angle),
                0.5 + 0.3 * Math.sin(angle)
            );
        }),
        trackCount: rows.length,
        computedAt: new Date().toISOString(),
    };

    await cacheResult(result);

    return result;
}

function runUmapInWorker(
    embeddings: number[][],
    nNeighbors: number
): Promise<number[][]> {
    return new Promise((resolve, reject) => {
        const workerPath = resolveUmapWorkerPath();
        const worker = new Worker(workerPath, {
            workerData: { embeddings, nNeighbors },
            // tsx's loader hooks don't propagate into worker_threads, so a
            // .ts worker (tsx dev mode — no compiled dist/) must register tsx
            // in its own execArgv or Node rejects the file extension.
            ...(workerPath.endsWith(".ts")
                ? { execArgv: ["--import", "tsx"] }
                : {}),
        });

        let settled = false;

        const warnTimer = setTimeout(() => {
            logger.warn(
                `[VIBE-MAP] UMAP worker running for 5+ minutes (${embeddings.length} tracks)`
            );
        }, UMAP_WARN_MS);

        const timeoutTimer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(warnTimer);
            worker.terminate();
            reject(
                new Error(
                    `UMAP worker timed out after ${UMAP_TIMEOUT_MS / 60000} minutes`
                )
            );
        }, UMAP_TIMEOUT_MS);

        worker.on("message", (result) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(warnTimer);
            clearTimeout(timeoutTimer);

            const payload = result as { error?: string } | number[][];
            if (!Array.isArray(payload) && payload?.error) {
                reject(new Error(payload.error));
                return;
            }

            resolve(payload as number[][]);
        });

        worker.on("error", (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(warnTimer);
            clearTimeout(timeoutTimer);
            reject(error);
        });

        worker.on("exit", (code) => {
            if (settled || code === 0) {
                return;
            }
            settled = true;
            clearTimeout(warnTimer);
            clearTimeout(timeoutTimer);
            reject(new Error(`UMAP worker exited with code ${code}`));
        });
    });
}

async function doCompute(): Promise<VibeMapResponse> {
    const startedAt = Date.now();

    const rows = await prisma.$queryRaw<Array<TrackRow & { embedding: string }>>`
        SELECT
            te.track_id,
            t.title,
            ar.name as "artistName",
            ar.id as "artistId",
            a.id as "albumId",
            a."coverUrl",
            t.energy,
            t.valence,
            t."moodHappy",
            t."moodSad",
            t."moodRelaxed",
            t."moodAggressive",
            t."moodParty",
            t."moodAcoustic",
            t."moodElectronic",
            t.bpm,
            t.danceability,
            t.acousticness,
            t.instrumentalness,
            t.key,
            t."keyScale",
            tl.sentiment as "lyricSentiment",
            tl."lexicalDiversity" as "lyricLexicalDiversity",
            tl."readingLevel" as "lyricReadingLevel",
            tl."analysisStatus" as "lyricsAnalysisStatus",
            tl."isInstrumental" as "lyricsInstrumental",
            te.embedding::text as embedding
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        LEFT JOIN "TrackLyrics" tl ON tl."trackId" = t.id
        ORDER BY RANDOM()
        LIMIT ${MAX_EMBEDDINGS}
    `;

    if (rows.length === 0) {
        return {
            tracks: [],
            trackCount: 0,
            computedAt: new Date().toISOString(),
        };
    }

    if (rows.length < MIN_TRACKS_FOR_UMAP) {
        return buildCircularLayout(rows);
    }

    const sampled = rows.length === MAX_EMBEDDINGS;
    logger.info(
        `[VIBE-MAP] Computing UMAP projection for ${rows.length} tracks${sampled ? " (sampled)" : ""}`
    );

    const embeddings = rows.map((row) => parseEmbedding(row.embedding));
    const nNeighbors = Math.min(15, Math.max(2, Math.floor(rows.length / 2)));
    const projection = await runUmapInWorker(embeddings, nNeighbors);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const [x, y] of projection) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    const tracks = rows.map((row, index) =>
        buildMapTrack(
            row,
            (projection[index][0] - minX) / rangeX,
            (projection[index][1] - minY) / rangeY
        )
    );

    const result: VibeMapResponse = {
        tracks,
        trackCount: tracks.length,
        ...(sampled ? { sampled: true } : {}),
        computedAt: new Date().toISOString(),
    };

    await cacheResult(result);

    logger.info(
        `[VIBE-MAP] UMAP projection computed in ${Date.now() - startedAt}ms for ${tracks.length} tracks`
    );

    return result;
}

/**
 * Read the cached projection without triggering a compute. Prefer
 * getCachedProjectionIds() when only id order / computedAt is needed — this
 * pays a multi-MB JSON.parse.
 */
export async function getCachedProjection(): Promise<VibeMapResponse | null> {
    const cached = await redisClient.get(CACHE_KEY);
    return cached ? (JSON.parse(cached) as VibeMapResponse) : null;
}

/**
 * Read the cached projection as its raw JSON string, for handlers that send
 * it straight to the wire (`/map` cache hits skip parse + re-stringify).
 */
export async function getCachedProjectionRaw(): Promise<string | null> {
    return redisClient.get(CACHE_KEY);
}

/**
 * Read the slim ordered id list for the cached projection. Consumers that
 * need index-alignment with the served map (the mixer endpoint) must use
 * THIS id order. Falls back to deriving from the full projection when the
 * slim key alone was evicted, so the mixer degrades to the old parse cost
 * instead of 409ing until the 24h expiry. Never computes.
 */
export async function getCachedProjectionIds(): Promise<VibeMapIdsPayload | null> {
    const cached = await redisClient.get(IDS_CACHE_KEY);
    if (cached) {
        return JSON.parse(cached) as VibeMapIdsPayload;
    }

    const projection = await getCachedProjection();
    if (!projection) {
        return null;
    }

    return {
        computedAt: projection.computedAt,
        trackCount: projection.trackCount,
        ids: projection.tracks.map((track) => track.id),
    };
}

export async function computeMapProjection(): Promise<VibeMapResponse> {
    const cached = await redisClient.get(CACHE_KEY);
    if (cached) {
        logger.debug("[VIBE-MAP] Cache hit (stable key)");
        return JSON.parse(cached) as VibeMapResponse;
    }

    if (computePromise) {
        logger.info("[VIBE-MAP] Waiting for in-progress computation");
        return computePromise;
    }

    computePromise = doCompute();
    try {
        return await computePromise;
    } finally {
        computePromise = null;
    }
}
