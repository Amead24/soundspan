export {};

const mockExistsSync = jest.fn();
const mockRedisGet = jest.fn();
const mockTrackFindFirst = jest.fn();
const mockTrackEmbeddingCount = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("fs", () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: (...args: unknown[]) => mockRedisGet(...args),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findFirst: (...args: unknown[]) => mockTrackFindFirst(...args),
        },
        trackEmbedding: {
            count: (...args: unknown[]) => mockTrackEmbeddingCount(...args),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

describe("featureDetection service", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    async function loadService() {
        const mod = await import("../featureDetection");
        mod.featureDetection.invalidateCache();
        return mod.featureDetection;
    }

    it("reports analyzer features when scripts exist; lyric worker still needs a heartbeat", async () => {
        const service = await loadService();
        mockExistsSync.mockImplementation((candidate: string) =>
            [
                "/app/audio-analyzer/analyzer.py",
                "/app/audio-analyzer-clap/analyzer.py",
            ].includes(String(candidate))
        );
        mockRedisGet.mockResolvedValue(null);

        await expect(service.getFeatures()).resolves.toEqual({
            musicCNN: true,
            vibeEmbeddings: true,
            lyricAnalysis: false,
        });
        // The lyric worker has no bundled-script fallback — its check always
        // hits the heartbeat key, and only that key.
        expect(mockRedisGet).toHaveBeenCalledTimes(1);
        expect(mockRedisGet).toHaveBeenCalledWith("lyrics:worker:heartbeat");
        expect(mockTrackFindFirst).not.toHaveBeenCalled();
        expect(mockTrackEmbeddingCount).not.toHaveBeenCalled();
    });

    it("falls back to heartbeat and embedding checks when scripts are absent", async () => {
        const service = await loadService();
        const now = Date.now();
        mockExistsSync.mockReturnValue(false);
        mockRedisGet.mockImplementation(async (key: string) => {
            if (key === "audio:worker:heartbeat") return String(now);
            if (key === "lyrics:worker:heartbeat") return String(now);
            return null;
        });
        mockTrackEmbeddingCount.mockResolvedValueOnce(2);

        await expect(service.getFeatures()).resolves.toEqual({
            musicCNN: true,
            vibeEmbeddings: true,
            lyricAnalysis: true,
        });
        expect(mockRedisGet).toHaveBeenCalledWith("audio:worker:heartbeat");
        expect(mockRedisGet).toHaveBeenCalledWith("clap:worker:heartbeat");
        expect(mockRedisGet).toHaveBeenCalledWith("lyrics:worker:heartbeat");
        expect(mockTrackEmbeddingCount).toHaveBeenCalledTimes(1);
    });

    it("treats a stale lyric-worker heartbeat as absent", async () => {
        const service = await loadService();
        const staleMs = Date.now() - 6 * 60 * 1000; // HEARTBEAT_TTL is 5 min
        mockExistsSync.mockReturnValue(true);
        mockRedisGet.mockResolvedValue(String(staleMs));

        const features = await service.getFeatures();
        expect(features.lyricAnalysis).toBe(false);
    });

    it("falls back to database feature presence when heartbeat is stale or missing", async () => {
        const service = await loadService();
        mockExistsSync.mockReturnValue(false);
        mockRedisGet.mockResolvedValue(null);
        mockTrackFindFirst.mockResolvedValueOnce({ id: "track-1" });
        mockTrackEmbeddingCount.mockResolvedValueOnce(0);

        await expect(service.getFeatures()).resolves.toEqual({
            musicCNN: true,
            vibeEmbeddings: false,
            lyricAnalysis: false,
        });
        expect(mockTrackFindFirst).toHaveBeenCalledWith({
            where: { energy: { not: null } },
            select: { id: true },
        });
    });

    it("returns false flags and logs when checks throw", async () => {
        const service = await loadService();
        mockExistsSync.mockReturnValue(false);
        mockRedisGet.mockImplementation(() => {
            throw new Error("redis down");
        });

        await expect(service.getFeatures()).resolves.toEqual({
            musicCNN: false,
            vibeEmbeddings: false,
            lyricAnalysis: false,
        });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[FEATURE-DETECTION] Error checking MusicCNN:",
            expect.any(Error)
        );
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[FEATURE-DETECTION] Error checking CLAP:",
            expect.any(Error)
        );
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[FEATURE-DETECTION] Error checking lyric worker:",
            expect.any(Error)
        );
    });

    it("uses cache until invalidated", async () => {
        const service = await loadService();
        mockExistsSync.mockImplementation((candidate: string) =>
            String(candidate).includes("audio-analyzer")
        );

        const first = await service.getFeatures();
        expect(first).toEqual({
            musicCNN: true,
            vibeEmbeddings: true,
            lyricAnalysis: false,
        });

        mockExistsSync.mockReturnValue(false);
        mockRedisGet.mockResolvedValue(null);
        mockTrackFindFirst.mockResolvedValue(null);
        mockTrackEmbeddingCount.mockResolvedValue(0);

        const cached = await service.getFeatures();
        expect(cached).toEqual({
            musicCNN: true,
            vibeEmbeddings: true,
            lyricAnalysis: false,
        });

        service.invalidateCache();
        const refreshed = await service.getFeatures();
        expect(refreshed).toEqual({
            musicCNN: false,
            vibeEmbeddings: false,
            lyricAnalysis: false,
        });
    });
});
