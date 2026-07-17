import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { requireInternalSecret } from "../middleware/internalAuth";

const router = Router();

// Each route here is guarded per-route (rather than with a router-wide
// `router.use`) so that when this router is mounted in front of the
// feature-disabled handler (index.ts, AUDIO_ANALYSIS_ENABLED=false),
// non-matching /api/analysis paths fall through to the documented
// FEATURE_DISABLED 404 instead of being rejected by a blanket check.
// requireInternalSecret fails closed when the secret is unconfigured.
//
// Besides the machine callbacks, this router also carries the admin
// /lyrics/retry endpoint: the lyrics pipeline runs off its own
// LYRICS_ANALYSIS_ENABLED flag, so its recovery path must stay reachable
// when AUDIO_ANALYSIS_ENABLED=false — the same reasoning that put the
// lyrics failure/success callbacks here.

/**
 * @openapi
 * /api/analysis/vibe/failure:
 *   post:
 *     summary: Record a vibe embedding failure (internal)
 *     description: Called by the CLAP analyzer service. Uses x-internal-secret header for authentication instead of user session.
 *     tags: [Analysis]
 *     parameters:
 *       - in: header
 *         name: x-internal-secret
 *         required: true
 *         schema:
 *           type: string
 *         description: Shared secret for internal service authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [trackId]
 *             properties:
 *               trackId:
 *                 type: string
 *               trackName:
 *                 type: string
 *               errorMessage:
 *                 type: string
 *               errorCode:
 *                 type: string
 *     responses:
 *       200:
 *         description: Failure recorded
 *       400:
 *         description: trackId is required
 *       403:
 *         description: Invalid internal secret
 */
/**
 * POST /api/analysis/vibe/failure
 * Record a vibe embedding failure (called by CLAP analyzer)
 */
router.post("/vibe/failure", requireInternalSecret, async (req, res) => {
    try {
        const { trackId, trackName, errorMessage, errorCode } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        await enrichmentFailureService.recordFailure({
            entityType: "vibe",
            entityId: trackId,
            entityName: trackName,
            errorMessage: errorMessage || "Vibe embedding generation failed",
            errorCode: errorCode,
        });

        res.json({ message: "Failure recorded" });
    } catch (error: any) {
        logger.error("Record vibe failure error:", error);
        res.status(500).json({ error: "Failed to record failure" });
    }
});

/**
 * @openapi
 * /api/analysis/vibe/success:
 *   post:
 *     summary: Resolve vibe failure records on success (internal)
 *     description: Called by the CLAP analyzer service. Uses x-internal-secret header for authentication instead of user session.
 *     tags: [Analysis]
 *     parameters:
 *       - in: header
 *         name: x-internal-secret
 *         required: true
 *         schema:
 *           type: string
 *         description: Shared secret for internal service authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [trackId]
 *             properties:
 *               trackId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Stale failures resolved
 *       400:
 *         description: trackId is required
 *       403:
 *         description: Invalid internal secret
 */
/**
 * POST /api/analysis/vibe/success
 * Resolve failure records when a vibe embedding succeeds (called by CLAP analyzer)
 */
router.post("/vibe/success", requireInternalSecret, async (req, res) => {
    try {
        const { trackId } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        // Resolve any stale failure records for this track
        await enrichmentFailureService.resolveByEntity("vibe", trackId);

        res.json({ message: "Stale failures resolved" });
    } catch (error: any) {
        logger.error("Resolve vibe failure error:", error);
        res.status(500).json({ error: "Failed to resolve failures" });
    }
});

/**
 * @openapi
 * /api/analysis/lyrics/failure:
 *   post:
 *     summary: Record a lyric analysis failure (internal)
 *     description: Called by the CLAP sidecar's lyric worker. Uses x-internal-secret header for authentication instead of user session.
 *     tags: [Analysis]
 *     parameters:
 *       - in: header
 *         name: x-internal-secret
 *         required: true
 *         schema:
 *           type: string
 *         description: Shared secret for internal service authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [trackId]
 *             properties:
 *               trackId:
 *                 type: string
 *               trackName:
 *                 type: string
 *               errorMessage:
 *                 type: string
 *               errorCode:
 *                 type: string
 *     responses:
 *       200:
 *         description: Failure recorded
 *       400:
 *         description: trackId is required
 *       403:
 *         description: Invalid internal secret
 */
/**
 * POST /api/analysis/lyrics/failure
 * Record a lyric analysis failure (called by the CLAP sidecar's lyric worker)
 */
router.post("/lyrics/failure", requireInternalSecret, async (req, res) => {
    try {
        const { trackId, trackName, errorMessage, errorCode } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        await enrichmentFailureService.recordFailure({
            entityType: "lyrics",
            entityId: trackId,
            entityName: trackName,
            errorMessage: errorMessage || "Lyric analysis failed",
            errorCode: errorCode,
        });

        res.json({ message: "Failure recorded" });
    } catch (error: any) {
        logger.error("Record lyric analysis failure error:", error);
        res.status(500).json({ error: "Failed to record failure" });
    }
});

/**
 * @openapi
 * /api/analysis/lyrics/success:
 *   post:
 *     summary: Resolve lyric analysis failure records on success (internal)
 *     description: Called by the CLAP sidecar's lyric worker. Uses x-internal-secret header for authentication instead of user session.
 *     tags: [Analysis]
 *     parameters:
 *       - in: header
 *         name: x-internal-secret
 *         required: true
 *         schema:
 *           type: string
 *         description: Shared secret for internal service authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [trackId]
 *             properties:
 *               trackId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Stale failures resolved
 *       400:
 *         description: trackId is required
 *       403:
 *         description: Invalid internal secret
 */
/**
 * POST /api/analysis/lyrics/success
 * Resolve failure records when lyric analysis succeeds (called by the CLAP
 * sidecar's lyric worker)
 */
router.post("/lyrics/success", requireInternalSecret, async (req, res) => {
    try {
        const { trackId } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        await enrichmentFailureService.resolveByEntity("lyrics", trackId);

        res.json({ message: "Stale failures resolved" });
    } catch (error: any) {
        logger.error("Resolve lyric analysis failure error:", error);
        res.status(500).json({ error: "Failed to resolve failures" });
    }
});

/**
 * @openapi
 * /api/analysis/lyrics/retry:
 *   post:
 *     summary: Retry failed lyric analyses
 *     description: Resets every failed lyric analysis to pending (clearing the error and retry count) and resolves its failure records. The enrichment worker's lyrics phase re-queues pending rows on its next cycle, behind the lyric-worker heartbeat gate.
 *     tags: [Analysis]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Failed lyric analyses reset to pending
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /api/analysis/lyrics/retry
 * Retry failed lyric analyses (admin only)
 *
 * Unlike /vibe/retry this does not RPUSH directly: lyric queueing is owned by
 * the enrichment lyrics phase, which only queues against a live lyric-worker
 * heartbeat and flips rows to processing AFTER a successful enqueue. Resetting
 * to 'pending' hands the rows back to that one queueing path. Driven off the
 * TrackLyrics table (not EnrichmentFailure rows) so rows whose failure
 * callback never landed are still recoverable.
 */
router.post("/lyrics/retry", requireAuth, requireAdmin, async (req, res) => {
    try {
        const failedRows = await prisma.trackLyrics.findMany({
            where: { analysisStatus: "failed" },
            select: { trackId: true },
        });

        if (failedRows.length === 0) {
            return res.json({
                message: "No failed lyric analyses to retry",
                reset: 0,
            });
        }

        const trackIds = failedRows.map((row) => row.trackId);

        // Reset the whole failed state. analysisRetryCount goes back to 0
        // deliberately (the Essentia retry-count trap: a status-only reset
        // leaves max-retried rows permanently skipped by 3-strike sweeps).
        const result = await prisma.trackLyrics.updateMany({
            where: { trackId: { in: trackIds }, analysisStatus: "failed" },
            data: {
                analysisStatus: "pending",
                analysisError: null,
                analysisStartedAt: null,
                analysisRetryCount: 0,
            },
        });

        await enrichmentFailureService.resolveByEntities("lyrics", trackIds);

        logger.info(`Reset ${result.count} failed lyric analyses for retry`);

        res.json({
            message: `Reset ${result.count} failed lyric analyses; the next enrichment cycle will re-queue them`,
            reset: result.count,
        });
    } catch (error: any) {
        logger.error("Retry lyric analyses error:", error);
        res.status(500).json({ error: "Failed to retry lyric analyses" });
    }
});

/**
 * Machine-to-machine callbacks invoked by the CLAP analyzer service
 * (`/api/analysis/vibe/failure`, `/api/analysis/vibe/success`, and the lyric
 * worker's `/api/analysis/lyrics/failure` + `/api/analysis/lyrics/success`),
 * plus the admin `/api/analysis/lyrics/retry` recovery endpoint.
 *
 * Kept in a dedicated router so they stay mounted under `/api/analysis` even
 * when `AUDIO_ANALYSIS_ENABLED=false` — analyzers draining in-flight queue
 * items (e.g. AIO deployments, where the in-container analyzers are not
 * controlled by the flag) must always be able to report results, and the
 * lyrics pipeline (its own LYRICS_ANALYSIS_ENABLED flag) must keep its
 * recovery path.
 */
export default router;
