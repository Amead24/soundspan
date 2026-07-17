import { Router } from "express";
import { logger } from "../utils/logger";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { requireInternalSecret } from "../middleware/internalAuth";

const router = Router();

// Each machine-to-machine callback is guarded per-route (rather than with a
// router-wide `router.use`) so that when this router is mounted in front of
// the feature-disabled handler (index.ts, AUDIO_ANALYSIS_ENABLED=false),
// non-callback /api/analysis paths fall through to the documented
// FEATURE_DISABLED 404 instead of being rejected 403 by the secret check.
// requireInternalSecret fails closed when the secret is unconfigured.

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
 * Machine-to-machine callbacks invoked by the CLAP analyzer service
 * (`/api/analysis/vibe/failure`, `/api/analysis/vibe/success`, and the lyric
 * worker's `/api/analysis/lyrics/failure` + `/api/analysis/lyrics/success`).
 *
 * Kept in a dedicated router so they stay mounted under `/api/analysis` even
 * when `AUDIO_ANALYSIS_ENABLED=false` — analyzers draining in-flight queue
 * items (e.g. AIO deployments, where the in-container analyzers are not
 * controlled by the flag) must always be able to report results.
 */
export default router;
