import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

// Mirrors vibeAnalysisCleanup: 30 minutes covers a cold model load plus a
// long lyric sheet on a slow host.
const STALE_THRESHOLD_MINUTES = 30;
const MAX_RETRIES = 3;

class LyricsAnalysisCleanupService {
    /**
     * Reset TrackLyrics rows stuck in "processing".
     *
     * Resets go to NULL — not "pending" — mirroring vibeAnalysisCleanup, which
     * is why every queue-selection filter must accept
     * (analysisStatus IS NULL OR analysisStatus = 'pending').
     * Rows on their third strike flip to "failed" so reconciliation stops
     * re-queueing them forever.
     */
    async cleanupStaleProcessing(): Promise<{ reset: number; failed: number }> {
        const cutoff = new Date(
            Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000
        );
        const staleWhere = {
            analysisStatus: "processing",
            OR: [
                { analysisStartedAt: { lt: cutoff } },
                { analysisStartedAt: null, updatedAt: { lt: cutoff } },
            ],
        };

        const failed = await prisma.trackLyrics.updateMany({
            where: { ...staleWhere, analysisRetryCount: { gte: MAX_RETRIES - 1 } },
            data: {
                analysisStatus: "failed",
                analysisError: `Stale processing (>${STALE_THRESHOLD_MINUTES} min) after ${MAX_RETRIES} attempts`,
                analysisStartedAt: null,
            },
        });

        const reset = await prisma.trackLyrics.updateMany({
            where: { ...staleWhere, analysisRetryCount: { lt: MAX_RETRIES - 1 } },
            data: {
                analysisStatus: null,
                analysisStartedAt: null,
                analysisRetryCount: { increment: 1 },
            },
        });

        if (failed.count > 0 || reset.count > 0) {
            logger.debug(
                `[LyricsAnalysisCleanup] Stale lyric analysis: reset ${reset.count} for retry, permanently failed ${failed.count}`
            );
        }

        return { reset: reset.count, failed: failed.count };
    }
}

export const lyricsAnalysisCleanupService = new LyricsAnalysisCleanupService();
