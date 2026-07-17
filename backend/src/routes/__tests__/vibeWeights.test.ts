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
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        track: {
            findUnique: jest.fn(),
        },
        likedTrack: {
            findMany: jest.fn(async () => []),
        },
        dislikedEntity: {
            findMany: jest.fn(async () => []),
        },
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
import { DEFAULT_SIMILARITY_WEIGHTS } from "../../services/similarityWeights";

const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockUserUpdate = prisma.user.update as jest.Mock;
const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
const mockFindSimilarTracks = findSimilarTracks as jest.Mock;

function getHandler(path: string, method: "get" | "put") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
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

function customWeights() {
    return {
        ...DEFAULT_SIMILARITY_WEIGHTS,
        clap: 0.3,
        lyricSemantic: 0.25,
    };
}

describe("similarity weights routes", () => {
    const getWeights = getHandler("/weights", "get");
    const putWeights = getHandler("/weights", "put");
    const getSimilar = getHandler("/similar/:trackId", "get");

    beforeEach(() => {
        jest.clearAllMocks();
        mockUserFindUnique.mockResolvedValue({ similarityWeights: null });
        mockUserUpdate.mockResolvedValue({});
        mockTrackFindUnique.mockResolvedValue(null);
    });

    it("GET returns defaults with isDefault=true when nothing is stored", async () => {
        const res = createRes();
        await getWeights({ user: { id: "user-1" } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            weights: DEFAULT_SIMILARITY_WEIGHTS,
            isDefault: true,
        });
    });

    it("GET returns the stored mix with isDefault=false", async () => {
        mockUserFindUnique.mockResolvedValue({
            similarityWeights: customWeights(),
        });

        const res = createRes();
        await getWeights({ user: { id: "user-1" } } as any, res);

        expect(res.body).toEqual({
            weights: customWeights(),
            isDefault: false,
        });
    });

    it("GET falls back to defaults when the stored JSON is garbage", async () => {
        mockUserFindUnique.mockResolvedValue({
            similarityWeights: { clap: "loud", legacy: true },
        });

        const res = createRes();
        await getWeights({ user: { id: "user-1" } } as any, res);

        expect(res.body).toEqual({
            weights: DEFAULT_SIMILARITY_WEIGHTS,
            isDefault: true,
        });
    });

    it("PUT persists a valid mix and echoes it back", async () => {
        const res = createRes();
        await putWeights(
            { user: { id: "user-1" }, body: customWeights() } as any,
            res
        );

        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: "user-1" },
            data: { similarityWeights: customWeights() },
        });
        expect(res.body).toEqual({
            weights: customWeights(),
            isDefault: false,
        });
    });

    it("PUT rejects invalid payloads with 400 and writes nothing", async () => {
        const res = createRes();
        await putWeights(
            {
                user: { id: "user-1" },
                body: { ...customWeights(), clap: 2 },
            } as any,
            res
        );

        expect(res.statusCode).toBe(400);
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it("PUT null resets to defaults (clears the stored mix)", async () => {
        const res = createRes();
        await putWeights({ user: { id: "user-1" }, body: null } as any, res);

        expect(mockUserUpdate).toHaveBeenCalledTimes(1);
        const updateArg = mockUserUpdate.mock.calls[0][0];
        expect(updateArg.where).toEqual({ id: "user-1" });
        // Prisma.DbNull sentinel — asserting shape, not the class instance
        expect(updateArg.data).toHaveProperty("similarityWeights");
        expect(res.body).toEqual({
            weights: DEFAULT_SIMILARITY_WEIGHTS,
            isDefault: true,
        });
    });

    it("GET /similar threads the user's stored weights into findSimilarTracks", async () => {
        mockUserFindUnique.mockResolvedValue({
            similarityWeights: customWeights(),
        });
        mockFindSimilarTracks.mockResolvedValue([
            {
                id: "track-2",
                title: "Candidate",
                duration: 200,
                distance: 0.1,
                similarity: 0.9,
                albumId: "album-1",
                albumTitle: "Album",
                albumCoverUrl: null,
                artistId: "artist-1",
                artistName: "Artist",
                energy: 0.5,
                valence: 0.5,
                danceability: 0.5,
                arousal: 0.5,
            },
        ]);

        const res = createRes();
        await getSimilar(
            {
                user: { id: "user-1" },
                params: { trackId: "track-1" },
                query: {},
            } as any,
            res
        );

        expect(mockFindSimilarTracks).toHaveBeenCalledWith(
            "track-1",
            20,
            customWeights()
        );
        expect(res.statusCode).toBe(200);
    });

    it("GET /similar uses defaults when the user stored nothing", async () => {
        mockFindSimilarTracks.mockResolvedValue([
            {
                id: "track-2",
                title: "Candidate",
                duration: 200,
                distance: 0.1,
                similarity: 0.9,
                albumId: "album-1",
                albumTitle: "Album",
                albumCoverUrl: null,
                artistId: "artist-1",
                artistName: "Artist",
                energy: null,
                valence: null,
                danceability: null,
                arousal: null,
            },
        ]);

        const res = createRes();
        await getSimilar(
            {
                user: { id: "user-1" },
                params: { trackId: "track-1" },
                query: {},
            } as any,
            res
        );

        expect(mockFindSimilarTracks).toHaveBeenCalledWith(
            "track-1",
            20,
            DEFAULT_SIMILARITY_WEIGHTS
        );
    });
});
