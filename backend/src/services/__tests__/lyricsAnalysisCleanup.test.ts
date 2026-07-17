const mockUpdateMany = jest.fn();
const mockLoggerDebug = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        trackLyrics: {
            updateMany: (...args: unknown[]) => mockUpdateMany(...args),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
    },
}));

import { lyricsAnalysisCleanupService } from "../lyricsAnalysisCleanup";

describe("lyricsAnalysisCleanupService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns zeros and logs nothing when no stale rows exist", async () => {
        mockUpdateMany.mockResolvedValue({ count: 0 });

        const result =
            await lyricsAnalysisCleanupService.cleanupStaleProcessing();

        expect(result).toEqual({ reset: 0, failed: 0 });
        expect(mockLoggerDebug).not.toHaveBeenCalled();
    });

    it("only targets processing rows older than the 30-minute threshold", async () => {
        mockUpdateMany.mockResolvedValue({ count: 0 });

        await lyricsAnalysisCleanupService.cleanupStaleProcessing();

        for (const [args] of mockUpdateMany.mock.calls) {
            expect(args.where.analysisStatus).toBe("processing");
            expect(args.where.OR).toEqual([
                { analysisStartedAt: { lt: expect.any(Date) } },
                { analysisStartedAt: null, updatedAt: { lt: expect.any(Date) } },
            ]);
            // Cutoff must actually be ~30 minutes in the past
            const cutoff = args.where.OR[0].analysisStartedAt.lt as Date;
            const ageMs = Date.now() - cutoff.getTime();
            expect(ageMs).toBeGreaterThanOrEqual(29 * 60 * 1000);
            expect(ageMs).toBeLessThanOrEqual(31 * 60 * 1000);
        }
    });

    it("resets under-max-retry rows to NULL (not 'pending') and increments the retry count", async () => {
        mockUpdateMany
            .mockResolvedValueOnce({ count: 0 }) // fail pass
            .mockResolvedValueOnce({ count: 2 }); // reset pass

        const result =
            await lyricsAnalysisCleanupService.cleanupStaleProcessing();

        const resetCall = mockUpdateMany.mock.calls[1][0];
        expect(resetCall.where.analysisRetryCount).toEqual({ lt: 2 });
        expect(resetCall.data).toEqual({
            analysisStatus: null,
            analysisStartedAt: null,
            analysisRetryCount: { increment: 1 },
        });
        expect(result).toEqual({ reset: 2, failed: 0 });
    });

    it("permanently fails rows on their third strike instead of resetting them", async () => {
        mockUpdateMany
            .mockResolvedValueOnce({ count: 1 }) // fail pass
            .mockResolvedValueOnce({ count: 0 }); // reset pass

        const result =
            await lyricsAnalysisCleanupService.cleanupStaleProcessing();

        const failCall = mockUpdateMany.mock.calls[0][0];
        expect(failCall.where.analysisRetryCount).toEqual({ gte: 2 });
        expect(failCall.data.analysisStatus).toBe("failed");
        expect(failCall.data.analysisStartedAt).toBeNull();
        expect(typeof failCall.data.analysisError).toBe("string");
        expect(result).toEqual({ reset: 0, failed: 1 });
    });

    it("propagates update failures so the caller can retry next cycle", async () => {
        mockUpdateMany.mockRejectedValueOnce(new Error("write failed"));

        await expect(
            lyricsAnalysisCleanupService.cleanupStaleProcessing()
        ).rejects.toThrow("write failed");
    });
});
