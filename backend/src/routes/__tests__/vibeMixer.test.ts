import { Request, Response } from "express";

jest.mock("crypto", () => ({
    randomUUID: jest.fn(() => "req-123"),
}));

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, _res: Response, next: () => void) => {
        (req as any).user = { id: "user-1" };
        next();
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        user: { findUnique: jest.fn(async () => null) },
        track: { findUnique: jest.fn() },
        likedTrack: { findMany: jest.fn(async () => []) },
        dislikedEntity: { findMany: jest.fn(async () => []) },
        $queryRaw: jest.fn(),
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
        del: jest.fn(),
        xAdd: jest.fn(),
        blPop: jest.fn(),
    },
}));

jest.mock("../../services/hybridSimilarity", () => ({
    findSimilarTracks: jest.fn(),
}));

jest.mock("../../utils/annQuery", () => ({
    runAnnQuery: jest.fn(),
}));

jest.mock("../../services/umapProjection", () => ({
    computeMapProjection: jest.fn(),
    getCachedProjection: jest.fn(),
    getCachedProjectionRaw: jest.fn(),
    getCachedProjectionIds: jest.fn(),
}));

jest.mock("../../utils/embedding", () => ({
    toVectorLiteral: jest.fn((embedding: number[]) => `[${embedding.join(",")}]`),
    parseEmbedding: jest.fn((text: string) => JSON.parse(text) as number[]),
}));

jest.mock("../../services/vibeVocabulary", () => ({
    loadVocabulary: jest.fn(),
    getVocabulary: jest.fn(() => null),
    expandQueryWithVocabulary: jest.fn(),
    rerankWithFeatures: jest.fn((tracks: unknown[]) => tracks),
}));

import router from "../vibe";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { getCachedProjectionIds } from "../../services/umapProjection";

const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockGetCachedProjectionIds = getCachedProjectionIds as jest.Mock;

function getHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) throw new Error(`Route not found: ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };
    return res;
}

// The mixer reads the slim ids companion key, never the full projection —
// parsing the multi-MB projection JSON per request was the endpoint's
// dominant cost (review finding A10).
function idsPayload(ids: string[]) {
    return {
        ids,
        trackCount: ids.length,
        computedAt: "2026-07-16T12:00:00.000Z",
    };
}

const mixerHandler = getHandler("/mixer/:trackId");

function makeReq() {
    return { user: { id: "user-1" }, params: { trackId: "seed" } } as any;
}

describe("GET /api/vibe/mixer/:trackId", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
    });

    it("409s with stale:true when no projection is cached", async () => {
        mockGetCachedProjectionIds.mockResolvedValue(null);

        const res = createRes();
        await mixerHandler(makeReq(), res);

        expect(res.statusCode).toBe(409);
        expect(res.body.stale).toBe(true);
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it("404s when the seed track has no CLAP embedding", async () => {
        mockGetCachedProjectionIds.mockResolvedValue(idsPayload(["a", "b"]));
        mockQueryRaw.mockResolvedValueOnce([]); // fetchTrackEmbedding

        const res = createRes();
        await mixerHandler(makeReq(), res);

        expect(res.statusCode).toBe(404);
    });

    it("returns arrays index-aligned to the projection order with nulls for holes", async () => {
        // Projection order deliberately differs from row order to prove
        // alignment. The scans are full-table (unfiltered), so both include a
        // row for a track OUTSIDE the projection — it must be ignored, never
        // shift alignment.
        mockGetCachedProjectionIds.mockResolvedValue(idsPayload(["b", "a", "missing"]));
        mockQueryRaw
            .mockResolvedValueOnce([{ embedding: "[1,0]" }]) // seed CLAP embedding
            .mockResolvedValueOnce([
                { track_id: "a", sim: 0.91234567 },
                { track_id: "not-on-the-map", sim: 0.99 },
                { track_id: "b", sim: 0.5 },
            ]) // clap scan (unordered, whole table)
            .mockResolvedValueOnce([{ embedding: "[0,1]" }]) // seed lyric embedding (lyric_ok)
            .mockResolvedValueOnce([
                { track_id: "a", sim: 0.25 },
                { track_id: "not-on-the-map", sim: 0.75 },
            ]); // lyric scan (whole table)

        const res = createRes();
        await mixerHandler(makeReq(), res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            seedId: "seed",
            computedAt: "2026-07-16T12:00:00.000Z",
            count: 3,
            clapSim: [0.5, 0.9123, null],
            lyricSim: [null, 0.25, null],
        });

        // Transport pin: the embedding params bound into `::vector` casts
        // must be pgvector TEXT literals ("[1,0]"), never raw number[] — the
        // Prisma 7 pg adapter binds a JS array as a Postgres ARRAY literal
        // ('{"1","0"}') and the query 22P02s against a real database (found
        // live: every mixer request 500ed while this suite stayed green).
        const clapScanParams = mockQueryRaw.mock.calls[1].slice(1);
        const lyricScanParams = mockQueryRaw.mock.calls[3].slice(1);
        expect(clapScanParams).toContain("[1,0]");
        expect(lyricScanParams).toContain("[0,1]");
        for (const call of mockQueryRaw.mock.calls) {
            for (const param of call.slice(1)) {
                expect(Array.isArray(param)).toBe(false);
            }
        }
    });

    it("null-fills the whole lyricSim array when the seed has no usable lyrics", async () => {
        mockGetCachedProjectionIds.mockResolvedValue(idsPayload(["a"]));
        mockQueryRaw
            .mockResolvedValueOnce([{ embedding: "[1,0]" }]) // seed CLAP
            .mockResolvedValueOnce([{ track_id: "a", sim: 0.8 }]) // clap scan
            .mockResolvedValueOnce([]); // seed lyric gate: not lyric_ok

        const res = createRes();
        await mixerHandler(makeReq(), res);

        expect(res.body.clapSim).toEqual([0.8]);
        expect(res.body.lyricSim).toEqual([null]);
        // Only 3 queries ran — no lyric scan without a usable seed
        expect(mockQueryRaw).toHaveBeenCalledTimes(3);
    });

    it("serves the seed+computedAt-scoped cache when present", async () => {
        mockGetCachedProjectionIds.mockResolvedValue(idsPayload(["a"]));
        const cached = {
            seedId: "seed",
            computedAt: "2026-07-16T12:00:00.000Z",
            count: 1,
            clapSim: [1],
            lyricSim: [null],
        };
        mockRedisGet.mockResolvedValue(JSON.stringify(cached));

        const res = createRes();
        await mixerHandler(makeReq(), res);

        expect(res.body).toEqual(cached);
        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockRedisGet).toHaveBeenCalledWith(
            "vibe:mixer:v1:seed:2026-07-16T12:00:00.000Z"
        );
    });

    it("caches the computed response with a 1h TTL", async () => {
        mockGetCachedProjectionIds.mockResolvedValue(idsPayload(["a"]));
        mockQueryRaw
            .mockResolvedValueOnce([{ embedding: "[1,0]" }])
            .mockResolvedValueOnce([{ track_id: "a", sim: 0.7 }])
            .mockResolvedValueOnce([]);

        const res = createRes();
        await mixerHandler(makeReq(), res);

        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "vibe:mixer:v1:seed:2026-07-16T12:00:00.000Z",
            3600,
            expect.any(String)
        );
    });
});
