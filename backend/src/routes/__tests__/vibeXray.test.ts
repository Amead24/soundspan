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
});
