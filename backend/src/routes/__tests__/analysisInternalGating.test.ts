import express from "express";
import request from "supertest";

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        recordFailure: jest.fn().mockResolvedValue({}),
        resolveByEntity: jest.fn().mockResolvedValue({}),
    },
}));

import analysisInternalRouter from "../analysisInternal";
import { createFeatureDisabledHandler } from "../../utils/featureGate";
import { enrichmentFailureService } from "../../services/enrichmentFailureService";

const mockRecordFailure = enrichmentFailureService.recordFailure as jest.Mock;
const mockResolveByEntity = enrichmentFailureService.resolveByEntity as jest.Mock;

/**
 * Mirrors the index.ts wiring when AUDIO_ANALYSIS_ENABLED=false: the internal
 * callback router is mounted in front of the feature-disabled handler so the
 * CLAP analyzer machine callbacks stay reachable while everything else under
 * /api/analysis returns the documented FEATURE_DISABLED 404 contract.
 */
function buildDisabledAnalysisApp() {
    const app = express();
    app.use(express.json());
    app.use(
        "/api/analysis",
        analysisInternalRouter,
        createFeatureDisabledHandler()
    );
    return app;
}

describe("analysisInternal router gating (AUDIO_ANALYSIS_ENABLED=false wiring)", () => {
    const originalSecret = process.env.INTERNAL_API_SECRET;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.INTERNAL_API_SECRET = "test-secret";
    });

    afterAll(() => {
        if (originalSecret === undefined) {
            delete process.env.INTERNAL_API_SECRET;
        } else {
            process.env.INTERNAL_API_SECRET = originalSecret;
        }
    });

    it("returns the FEATURE_DISABLED 404 contract for non-callback analysis routes", async () => {
        const app = buildDisabledAnalysisApp();

        for (const path of [
            "/api/analysis/workers",
            "/api/analysis/status",
            "/api/analysis/clap-workers",
        ]) {
            const res = await request(app).get(path);
            expect(res.status).toBe(404);
            expect(res.body).toEqual({
                error: "feature disabled",
                code: "FEATURE_DISABLED",
            });
        }
    });

    it("keeps requiring the internal secret on the analyzer callback routes", async () => {
        const app = buildDisabledAnalysisApp();

        const noSecret = await request(app)
            .post("/api/analysis/vibe/failure")
            .send({ trackId: "t1" });
        expect(noSecret.status).toBe(403);

        const wrongSecret = await request(app)
            .post("/api/analysis/vibe/success")
            .set("x-internal-secret", "wrong")
            .send({ trackId: "t1" });
        expect(wrongSecret.status).toBe(403);

        expect(mockRecordFailure).not.toHaveBeenCalled();
        expect(mockResolveByEntity).not.toHaveBeenCalled();
    });

    it("still serves authenticated analyzer callbacks while the feature is disabled", async () => {
        const app = buildDisabledAnalysisApp();

        const failure = await request(app)
            .post("/api/analysis/vibe/failure")
            .set("x-internal-secret", "test-secret")
            .send({ trackId: "t1", trackName: "Track" });
        expect(failure.status).toBe(200);
        expect(mockRecordFailure).toHaveBeenCalledWith(
            expect.objectContaining({ entityType: "vibe", entityId: "t1" })
        );

        const success = await request(app)
            .post("/api/analysis/vibe/success")
            .set("x-internal-secret", "test-secret")
            .send({ trackId: "t1" });
        expect(success.status).toBe(200);
        expect(mockResolveByEntity).toHaveBeenCalledWith("vibe", "t1");
    });

    it("keeps the admin lyrics retry endpoint reachable while the feature is disabled", async () => {
        // The lyrics pipeline runs off its own LYRICS_ANALYSIS_ENABLED flag,
        // so its recovery endpoint must not vanish with AUDIO_ANALYSIS_ENABLED.
        // Reachability contract: an unauthenticated request gets the auth
        // ladder's 401 — NOT the FEATURE_DISABLED 404 it would get if the
        // route moved back into the feature-gated analysis router.
        const app = buildDisabledAnalysisApp();

        const res = await request(app).post("/api/analysis/lyrics/retry");
        expect(res.status).toBe(401);
        expect(res.body).not.toEqual({
            error: "feature disabled",
            code: "FEATURE_DISABLED",
        });
    });

    it("fails closed on the callbacks when INTERNAL_API_SECRET is unset", async () => {
        delete process.env.INTERNAL_API_SECRET;
        const app = buildDisabledAnalysisApp();

        const res = await request(app)
            .post("/api/analysis/vibe/failure")
            .set("x-internal-secret", "")
            .send({ trackId: "t1" });
        expect(res.status).toBe(403);
        expect(mockRecordFailure).not.toHaveBeenCalled();
    });
});
