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
}));

jest.mock("../../utils/embedding", () => ({
    parseEmbedding: jest.fn(),
}));

jest.mock("../../services/vibeVocabulary", () => ({
    loadVocabulary: jest.fn(),
    getVocabulary: jest.fn(() => null),
    expandQueryWithVocabulary: jest.fn(),
    rerankWithFeatures: jest.fn((tracks: unknown[]) => tracks),
}));

import router from "../vibe";
import { prisma } from "../../utils/db";
import { findSimilarTracks } from "../../services/hybridSimilarity";

const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockFindSimilarTracks = findSimilarTracks as jest.Mock;

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

function neighbor(id: string) {
    return {
        id,
        title: `Track ${id}`,
        duration: 200,
        distance: 0.1,
        similarity: 0.9,
        albumId: `album-${id}`,
        albumTitle: "Album",
        albumCoverUrl: `cover-${id}.jpg`,
        artistId: `artist-${id}`,
        artistName: `Artist ${id}`,
        energy: 0.5,
        valence: 0.5,
        danceability: 0.5,
        arousal: 0.5,
    };
}

/** A fully-analyzed pair: alike sonically, diverging energy, lyrics on both. */
function fullRow(overrides: Record<string, unknown> = {}) {
    return {
        a_id: "a", a_title: "Song A", a_artist: "Artist A", a_album_id: "album-a", a_cover_url: "a.jpg",
        a_energy: 0.3, a_valence: 0.7, a_bpm: 72, a_danceability: 0.5,
        a_acousticness: 0.8, a_instrumentalness: 0.1,
        a_key: "A", a_key_scale: "minor",
        a_sentiment: 0.6, a_lexical: 60, a_reading: 5,
        a_lyric_status: "completed", a_lyric_instrumental: false,
        b_id: "b", b_title: "Song B", b_artist: "Artist B", b_album_id: "album-b", b_cover_url: "b.jpg",
        b_energy: 0.8, b_valence: 0.69, b_bpm: 124, b_danceability: 0.55,
        b_acousticness: 0.2, b_instrumentalness: 0.15,
        b_key: "E", b_key_scale: "minor",
        b_sentiment: -0.4, b_lexical: 40, b_reading: 7,
        b_lyric_status: "completed", b_lyric_instrumental: false,
        clap_sim: 0.88,
        lyric_sim: 0.42,
        bpm_sim: 0.75,
        key_sim: 0.85,
        ...overrides,
    };
}

const xrayHandler = getHandler("/xray");

function makeReq(query: Record<string, string> = { a: "a", b: "b" }) {
    return { user: { id: "user-1" }, query } as any;
}

describe("GET /api/vibe/xray", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindSimilarTracks.mockResolvedValue([]);
    });

    it("400s on missing or identical ids without querying", async () => {
        let res = createRes();
        await xrayHandler(makeReq({ a: "a" } as any), res);
        expect(res.statusCode).toBe(400);

        res = createRes();
        await xrayHandler(makeReq({ a: "x", b: "x" }), res);
        expect(res.statusCode).toBe(400);
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it("404s when either track is missing", async () => {
        mockQueryRaw.mockResolvedValueOnce([]);
        const res = createRes();
        await xrayHandler(makeReq(), res);
        expect(res.statusCode).toBe(404);
    });

    it("returns the full component breakdown for an analyzed pair", async () => {
        mockQueryRaw.mockResolvedValueOnce([fullRow()]);
        mockFindSimilarTracks
            .mockResolvedValueOnce([neighbor("n1"), neighbor("n2"), neighbor("only-a")])
            .mockResolvedValueOnce([neighbor("n2"), neighbor("n1"), neighbor("only-b")]);

        const res = createRes();
        await xrayHandler(makeReq(), res);

        expect(res.statusCode).toBe(200);
        const body = res.body;
        expect(body.a).toEqual({ id: "a", title: "Song A", artist: "Artist A", albumId: "album-a", coverUrl: "a.jpg" });
        expect(body.clap).toEqual({ available: true, similarity: 0.88 });
        expect(body.overall.weights).toBe("default");
        expect(body.overall.similarity).toBeGreaterThan(0);
        expect(body.overall.similarity).toBeLessThanOrEqual(1);

        const energy = body.features.find((f: any) => f.key === "energy");
        expect(energy.similarity).toBeCloseTo(0.5, 6); // 1 - |0.3-0.8|
        const bpm = body.features.find((f: any) => f.key === "bpm");
        expect(bpm).toEqual({ key: "bpm", a: 72, b: 124, similarity: 0.75 });

        expect(body.keys).toEqual({
            a: { key: "A", scale: "minor" },
            b: { key: "E", scale: "minor" },
            similarity: 0.85,
        });

        expect(body.lyrics.aStatus).toBe("analyzed");
        expect(body.lyrics.semanticSimilarity).toBe(0.42);
        expect(body.lyrics.sentiment.similarity).toBeCloseTo(1 - 1.0 / 2, 6); // |0.6 - -0.4| = 1
        expect(body.lyrics.lexical.similarity).toBeCloseTo(1 - 20 / 120, 6);

        // Intersection preserves side-a ranking, excludes non-shared
        expect(body.sharedNeighbors.map((n: any) => n.id)).toEqual(["n1", "n2"]);
        // Both neighbor lookups ran under the requester's weights arg
        expect(mockFindSimilarTracks).toHaveBeenCalledWith("a", 25, expect.any(Object));
        expect(mockFindSimilarTracks).toHaveBeenCalledWith("b", 25, expect.any(Object));
    });

    it("degrades gracefully when one side is instrumental", async () => {
        mockQueryRaw.mockResolvedValueOnce([
            fullRow({
                b_lyric_status: "instrumental",
                b_lyric_instrumental: true,
                b_sentiment: null,
                b_lexical: null,
                b_reading: null,
                lyric_sim: null,
            }),
        ]);

        const res = createRes();
        await xrayHandler(makeReq(), res);

        expect(res.body.lyrics).toEqual({
            aStatus: "analyzed",
            bStatus: "instrumental",
            semanticSimilarity: null,
            sentiment: null,
            lexical: null,
            reading: null,
        });
    });

    it("degrades gracefully when CLAP embeddings are missing", async () => {
        mockQueryRaw.mockResolvedValueOnce([fullRow({ clap_sim: null })]);

        const res = createRes();
        await xrayHandler(makeReq(), res);

        expect(res.body.clap).toEqual({ available: false, similarity: null });
        // Overall renormalizes over what's available — still a sane number
        expect(res.body.overall.similarity).toBeGreaterThan(0);
        expect(res.body.overall.similarity).toBeLessThanOrEqual(1);
    });

    it("handles tracks with no keys", async () => {
        mockQueryRaw.mockResolvedValueOnce([
            fullRow({ a_key: null, a_key_scale: null, key_sim: 0.5 }),
        ]);

        const res = createRes();
        await xrayHandler(makeReq(), res);

        expect(res.body.keys.a).toBeNull();
        expect(res.body.keys.b).toEqual({ key: "E", scale: "minor" });
    });

    // The closeness math exists in three deliberate copies: the scoring SQL,
    // these route helpers, and frontend simMath.ts. The frontend pins its copy
    // with enumerated numeric vectors (frontend/tests/unit/simMath.test.ts,
    // "closeness functions match the plan's §core-math definitions"); the two
    // cases below run the SAME vectors through the route so all three copies
    // share one set of pins. Change any copy and its pin together, never one
    // side alone. (Review finding B4.)
    it("closeness helpers reproduce the simMath numeric vectors (set 1)", async () => {
        mockQueryRaw.mockResolvedValueOnce([
            fullRow({
                a_energy: 0.8, b_energy: 0.3, // featureCloseness(0.8, 0.3) = 0.5
                a_valence: null, b_valence: 0.5, // null coalesces to 0.5 → 1.0
                a_sentiment: -1, b_sentiment: 1, // sentimentCloseness(-1, 1) = 0
                a_lexical: 20, b_lexical: 80, // lexicalCloseness(20, 80) = 0.5
                a_reading: 2, b_reading: 8, // readingCloseness(2, 8) = 0.5
            }),
        ]);

        const res = createRes();
        await xrayHandler(makeReq(), res);

        const byKey = Object.fromEntries(
            res.body.features.map((f: any) => [f.key, f.similarity])
        );
        expect(byKey.energy).toBeCloseTo(0.5, 9);
        expect(byKey.valence).toBeCloseTo(1.0, 9);
        expect(res.body.lyrics.sentiment.similarity).toBeCloseTo(0, 9);
        expect(res.body.lyrics.lexical.similarity).toBeCloseTo(0.5, 9);
        expect(res.body.lyrics.reading.similarity).toBeCloseTo(0.5, 9);
    });

    it("closeness helpers reproduce the simMath numeric vectors (set 2: clamps)", async () => {
        mockQueryRaw.mockResolvedValueOnce([
            fullRow({
                a_sentiment: 0.5, b_sentiment: 0.5, // sentimentCloseness = 1
                a_lexical: 200, b_lexical: 120, // both clamp to 120 → 1
                a_reading: 0, b_reading: 30, // gap clamps at 12 → 0
            }),
        ]);

        const res = createRes();
        await xrayHandler(makeReq(), res);

        expect(res.body.lyrics.sentiment.similarity).toBeCloseTo(1, 9);
        expect(res.body.lyrics.lexical.similarity).toBeCloseTo(1, 9);
        expect(res.body.lyrics.reading.similarity).toBeCloseTo(0, 9);
    });

    // D5 pin: for "completed analysis with a NULL scalar" — impossible today
    // (the sidecar writes results in one transaction) — the x-ray adds the
    // FULL lyric weight mass to the blend denominator once semantic+sentiment
    // are present, while the unfillable lexical/reading terms add nothing to
    // the numerator (the SQL blend would COALESCE them instead; the frontend
    // matches this x-ray shape). This exact-value pin keeps a future
    // partial-write path from silently changing which of the three behaviors
    // ships.
    it("blend denominator keeps the full lyric mass when lexical/reading scalars are null", async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
            similarityWeights: {
                clap: 0.4,
                lyricSemantic: 0.2,
                lyricSentiment: 0.2,
                lyricLexical: 0.1,
                lyricReading: 0.1,
                energy: 0,
                valence: 0,
                bpm: 0,
                danceability: 0,
                acousticness: 0,
                instrumentalness: 0,
                key: 0,
            },
        });
        mockQueryRaw.mockResolvedValueOnce([
            fullRow({
                clap_sim: 0.8,
                lyric_sim: 0.5,
                a_sentiment: 0.5,
                b_sentiment: 0.5,
                a_lexical: null,
                b_lexical: null,
                a_reading: null,
                b_reading: null,
            }),
        ]);

        const res = createRes();
        await xrayHandler(makeReq(), res);

        expect(res.body.lyrics.lexical).toBeNull();
        expect(res.body.lyrics.reading).toBeNull();
        expect(res.body.overall.weights).toBe("custom");
        // num = 0.4·0.8 + 0.2·0.5 + 0.2·1 (+ nothing for lexical/reading)
        // den = 0.4 + full lyricSum 0.6 = 1.0  →  0.62
        expect(res.body.overall.similarity).toBeCloseTo(0.62, 9);
    });
});
