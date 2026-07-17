import {
    DEFAULT_SIMILARITY_WEIGHTS,
    SIMILARITY_COMPONENTS,
    isDefaultWeights,
    resolveUserWeights,
    similarityWeightsSchema,
    splitAndNormalize,
    type SimilarityWeights,
} from "../similarityWeights";

function weights(overrides: Partial<SimilarityWeights> = {}): SimilarityWeights {
    return { ...DEFAULT_SIMILARITY_WEIGHTS, ...overrides };
}

describe("similarityWeights", () => {
    it("defaults sum to exactly 1.00 with all lyric knobs at zero", () => {
        const total = SIMILARITY_COMPONENTS.reduce(
            (sum, key) => sum + DEFAULT_SIMILARITY_WEIGHTS[key],
            0
        );
        expect(total).toBe(1);
        expect(DEFAULT_SIMILARITY_WEIGHTS.lyricSemantic).toBe(0);
        expect(DEFAULT_SIMILARITY_WEIGHTS.lyricSentiment).toBe(0);
        expect(DEFAULT_SIMILARITY_WEIGHTS.lyricLexical).toBe(0);
        expect(DEFAULT_SIMILARITY_WEIGHTS.lyricReading).toBe(0);
    });

    it("normalizing the defaults passes every value through bit-exactly", () => {
        // The backward-compat guarantee: default weights must emit the very
        // same numbers the historic hardcoded WEIGHTS constant did.
        const { norm, audioSum, lyricSum } = splitAndNormalize(
            DEFAULT_SIMILARITY_WEIGHTS
        );
        for (const key of SIMILARITY_COMPONENTS) {
            expect(norm[key]).toBe(DEFAULT_SIMILARITY_WEIGHTS[key]);
        }
        expect(audioSum).toBe(1);
        expect(lyricSum).toBe(0);
    });

    it("normalizes arbitrary raw weights to sum 1 and splits audio/lyric mass", () => {
        const { norm, audioSum, lyricSum } = splitAndNormalize(
            weights({ clap: 1, lyricSemantic: 1, energy: 0, valence: 0, bpm: 0, danceability: 0, acousticness: 0, instrumentalness: 0, key: 0 })
        );
        expect(norm.clap).toBeCloseTo(0.5, 10);
        expect(norm.lyricSemantic).toBeCloseTo(0.5, 10);
        expect(audioSum).toBeCloseTo(0.5, 10);
        expect(lyricSum).toBeCloseTo(0.5, 10);
        const total = SIMILARITY_COMPONENTS.reduce((s, k) => s + norm[k], 0);
        expect(total).toBeCloseTo(1, 10);
    });

    it("rejects out-of-range values, unknown keys, missing keys, and all-zero", () => {
        expect(similarityWeightsSchema.safeParse(weights({ clap: 1.5 })).success).toBe(false);
        expect(similarityWeightsSchema.safeParse(weights({ clap: -0.1 })).success).toBe(false);
        expect(
            similarityWeightsSchema.safeParse({ ...weights(), bogus: 0.5 }).success
        ).toBe(false);
        const { key: _dropped, ...missingOne } = weights();
        expect(similarityWeightsSchema.safeParse(missingOne).success).toBe(false);
        const allZero = Object.fromEntries(
            SIMILARITY_COMPONENTS.map((k) => [k, 0])
        );
        expect(similarityWeightsSchema.safeParse(allZero).success).toBe(false);
    });

    it("resolveUserWeights falls back to defaults on null, garbage, and legacy shapes", () => {
        expect(resolveUserWeights(null)).toEqual(DEFAULT_SIMILARITY_WEIGHTS);
        expect(resolveUserWeights(undefined)).toEqual(DEFAULT_SIMILARITY_WEIGHTS);
        expect(resolveUserWeights({ clap: "high" })).toEqual(DEFAULT_SIMILARITY_WEIGHTS);
        expect(resolveUserWeights(weights({ energy: 0.9 }))).toEqual(
            weights({ energy: 0.9 })
        );
    });

    it("isDefaultWeights detects exact defaults only", () => {
        expect(isDefaultWeights(weights())).toBe(true);
        expect(isDefaultWeights(weights({ lyricSemantic: 0.01 }))).toBe(false);
    });
});
