/**
 * Behavior tests for the enrichment "lyrics" phase (executeLyricsPhase):
 * bulk lyric fetch, instrumental classification, stale cleanup, and
 * heartbeat-gated queueing with the RPUSH-before-processing ordering rule.
 *
 * The cycle-level LYRICS_ANALYSIS_ENABLED gate reuses the exact pattern the
 * audio/vibe phases pin in unifiedEnrichmentRuntime.test.ts, so it is not
 * re-tested here; this file drives the phase directly via
 * __unifiedEnrichmentTestables.
 */
describe("enrichment lyrics phase", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function setupLyricsPhaseMocks(options?: {
        lyricWorkerAlive?: boolean;
        tracksMissingLyrics?: Array<{ id: string }>;
        queueableRows?: Array<{ trackId: string }>;
    }) {
        const callOrder: string[] = [];

        const trackFindMany = jest.fn(
            async () => options?.tracksMissingLyrics ?? [],
        );
        const trackLyricsFindMany = jest.fn(
            async () => options?.queueableRows ?? [],
        );
        const trackLyricsUpdateMany = jest.fn(async () => ({ count: 0 }));
        const trackLyricsUpdate = jest.fn(async (args: { where: { trackId: string } }) => {
            callOrder.push(`update:${args.where.trackId}`);
            return {};
        });

        const prisma = {
            track: { findMany: trackFindMany },
            trackLyrics: {
                findMany: trackLyricsFindMany,
                updateMany: trackLyricsUpdateMany,
                update: trackLyricsUpdate,
            },
        };

        const rpush = jest.fn(async (queue: string, payload: string) => {
            callOrder.push(`rpush:${JSON.parse(payload).trackId}`);
            return 1;
        });
        const redisMock = {
            rpush,
            llen: jest.fn(async () => 0),
            disconnect: jest.fn(),
        };

        const getLyrics = jest.fn(async () => ({
            syncedLyrics: null,
            plainLyrics: "some lyrics",
            source: "lrclib",
            synced: false,
        }));

        const cleanupStaleProcessing = jest.fn(async () => ({
            reset: 0,
            failed: 0,
        }));

        const getFeatures = jest.fn(async () => ({
            musicCNN: true,
            vibeEmbeddings: true,
            lyricAnalysis: options?.lyricWorkerAlive ?? false,
        }));

        jest.doMock("../../utils/db", () => ({
            prisma,
            Prisma: {
                PrismaClientKnownRequestError: class extends Error {
                    code = "P1001";
                },
                PrismaClientRustPanicError: class extends Error {},
                PrismaClientUnknownRequestError: class extends Error {},
            },
        }));
        jest.doMock("../../utils/logger", () => ({
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
        }));
        jest.doMock("../artistEnrichment", () => ({
            enrichSimilarArtist: jest.fn(),
        }));
        jest.doMock("../../services/lastfm", () => ({
            lastFmService: { getTrackInfo: jest.fn(async () => null) },
        }));
        jest.doMock("../../utils/ioredis", () => ({
            createIORedisClient: jest.fn(() => redisMock),
        }));
        jest.doMock("../../config", () => ({
            config: {
                features: {
                    audioAnalysis: true,
                    discovery: true,
                    autoPlaylists: true,
                    lyricsAnalysis: true,
                },
            },
        }));
        jest.doMock("../../services/enrichmentState", () => ({
            enrichmentStateService: {
                getState: jest.fn(async () => ({ status: "idle" })),
                updateState: jest.fn(async () => undefined),
                initializeState: jest.fn(async () => undefined),
                clear: jest.fn(async () => undefined),
            },
        }));
        jest.doMock("../../services/enrichmentFailureService", () => ({
            enrichmentFailureService: {
                recordFailure: jest.fn(async () => undefined),
                clearAllFailures: jest.fn(async () => undefined),
            },
        }));
        jest.doMock("../../services/audioAnalysisCleanup", () => ({
            audioAnalysisCleanupService: {
                cleanupStaleProcessing: jest.fn(async () => ({
                    reset: 0,
                    permanentlyFailed: 0,
                    recovered: 0,
                })),
                recordSuccess: jest.fn(),
                isCircuitOpen: jest.fn(() => false),
            },
        }));
        jest.doMock("../../services/rateLimiter", () => ({ rateLimiter: {} }));
        jest.doMock("../../services/vibeAnalysisCleanup", () => ({
            vibeAnalysisCleanupService: {
                cleanupStaleProcessing: jest.fn(async () => ({ reset: 0 })),
            },
        }));
        jest.doMock("../../services/lyricsAnalysisCleanup", () => ({
            lyricsAnalysisCleanupService: { cleanupStaleProcessing },
        }));
        jest.doMock("../../utils/systemSettings", () => ({
            getSystemSettings: jest.fn(async () => ({})),
        }));
        jest.doMock("../../services/featureDetection", () => ({
            featureDetection: { getFeatures },
        }));
        jest.doMock("../../services/moodBucketService", () => ({
            moodBucketService: {
                backfillAllTracks: jest.fn(async () => ({
                    processed: 0,
                    assigned: 0,
                })),
            },
        }));
        jest.doMock("../../services/notificationService", () => ({
            notificationService: {
                create: jest.fn(async () => undefined),
                notifySystem: jest.fn(async () => undefined),
            },
        }));
        jest.doMock("../../routes/podcasts", () => ({
            refreshPodcastFeed: jest.fn(async () => ({ newEpisodesCount: 0 })),
        }));
        jest.doMock("../../services/lyrics", () => ({ getLyrics }));
        jest.doMock("p-limit", () =>
            jest.fn(() => (fn: () => Promise<unknown>) => fn()),
        );
        jest.doMock("ioredis", () => jest.fn());

        return {
            callOrder,
            trackFindMany,
            trackLyricsFindMany,
            trackLyricsUpdateMany,
            trackLyricsUpdate,
            rpush,
            getLyrics,
            cleanupStaleProcessing,
            getFeatures,
        };
    }

    async function runPhaseUnderTest(): Promise<number> {
        const { __unifiedEnrichmentTestables } = await import(
            "../unifiedEnrichment"
        );
        return (
            __unifiedEnrichmentTestables as unknown as {
                executeLyricsPhase: () => Promise<number>;
            }
        ).executeLyricsPhase();
    }

    it("fetches lyrics for tracks with no TrackLyrics row and survives per-track failures", async () => {
        const mocks = setupLyricsPhaseMocks({
            tracksMissingLyrics: [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
        });
        mocks.getLyrics.mockRejectedValueOnce(new Error("lrclib down"));

        await runPhaseUnderTest();

        expect(mocks.trackFindMany).toHaveBeenCalledWith({
            where: { lyrics: { is: null } },
            select: { id: true },
            take: 500,
        });
        // First call rejected, but all three tracks were still attempted
        expect(mocks.getLyrics).toHaveBeenCalledTimes(3);
        expect(mocks.getLyrics).toHaveBeenCalledWith("t1");
        expect(mocks.getLyrics).toHaveBeenCalledWith("t3");
    });

    it("classifies no-lyrics rows as instrumental without touching already-classified rows", async () => {
        const mocks = setupLyricsPhaseMocks();

        await runPhaseUnderTest();

        expect(mocks.trackLyricsUpdateMany).toHaveBeenCalledWith({
            where: {
                analysisStatus: null,
                OR: [
                    { source: "none" },
                    {
                        AND: [
                            { OR: [{ plainLyrics: null }, { plainLyrics: "" }] },
                            { OR: [{ syncedLyrics: null }, { syncedLyrics: "" }] },
                        ],
                    },
                ],
            },
            data: { analysisStatus: "instrumental", isInstrumental: true },
        });
    });

    it("runs the stale-processing cleanup every phase", async () => {
        const mocks = setupLyricsPhaseMocks();

        await runPhaseUnderTest();

        expect(mocks.cleanupStaleProcessing).toHaveBeenCalledTimes(1);
    });

    it("queues nothing when the lyric worker heartbeat is absent", async () => {
        const mocks = setupLyricsPhaseMocks({
            lyricWorkerAlive: false,
            queueableRows: [{ trackId: "t1" }],
        });

        const queued = await runPhaseUnderTest();

        expect(queued).toBe(0);
        expect(mocks.rpush).not.toHaveBeenCalled();
        expect(mocks.trackLyricsUpdate).not.toHaveBeenCalled();
    });

    it("queues analyzable rows: RPUSH first, processing flip second, NULL-or-pending selection", async () => {
        const mocks = setupLyricsPhaseMocks({
            lyricWorkerAlive: true,
            queueableRows: [{ trackId: "t1" }, { trackId: "t2" }],
        });

        const queued = await runPhaseUnderTest();

        expect(queued).toBe(2);
        // Selection must accept NULL (stale-sweep resets) OR 'pending'
        // (admin resets), and never instrumentals.
        expect(mocks.trackLyricsFindMany).toHaveBeenCalledWith({
            where: {
                isInstrumental: false,
                OR: [{ analysisStatus: null }, { analysisStatus: "pending" }],
            },
            select: { trackId: true },
            take: 1000,
        });
        expect(mocks.rpush).toHaveBeenCalledWith(
            "lyrics:analysis:queue",
            JSON.stringify({ trackId: "t1" }),
        );
        expect(mocks.trackLyricsUpdate).toHaveBeenCalledWith({
            where: { trackId: "t1" },
            data: {
                analysisStatus: "processing",
                analysisStartedAt: expect.any(Date),
            },
        });
        // Never mark processing before the enqueue succeeded
        expect(mocks.callOrder).toEqual([
            "rpush:t1",
            "update:t1",
            "rpush:t2",
            "update:t2",
        ]);
    });

    it("does not flip a row to processing when its RPUSH fails, and continues with the rest", async () => {
        const mocks = setupLyricsPhaseMocks({
            lyricWorkerAlive: true,
            queueableRows: [{ trackId: "t1" }, { trackId: "t2" }],
        });
        mocks.rpush.mockRejectedValueOnce(new Error("redis down"));

        const queued = await runPhaseUnderTest();

        expect(queued).toBe(1);
        expect(mocks.trackLyricsUpdate).toHaveBeenCalledTimes(1);
        expect(mocks.trackLyricsUpdate).toHaveBeenCalledWith({
            where: { trackId: "t2" },
            data: expect.objectContaining({ analysisStatus: "processing" }),
        });
    });
});
