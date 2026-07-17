import { z } from "zod";

/**
 * The single backend home of the similarity-component list, default weights,
 * validation schema, and normalization math for user-adjustable similarity
 * ("weight mixer"). The frontend mirrors the component list and §blend math
 * in frontend/components/vibe/vibeMixer.ts — keep the two in sync.
 */

export const SIMILARITY_COMPONENTS = [
    "clap",
    "lyricSemantic",
    "lyricSentiment",
    "lyricLexical",
    "lyricReading",
    "energy",
    "valence",
    "bpm",
    "danceability",
    "acousticness",
    "instrumentalness",
    "key",
] as const;

export type SimilarityComponent = (typeof SIMILARITY_COMPONENTS)[number];
export type SimilarityWeights = Record<SimilarityComponent, number>;

/** The four lyric components share ONE availability gate (both tracks
 * lyric-analyzed and non-instrumental); everything else is always available
 * via 0.5-neutral coalescing. */
export const LYRIC_COMPONENTS = [
    "lyricSemantic",
    "lyricSentiment",
    "lyricLexical",
    "lyricReading",
] as const satisfies readonly SimilarityComponent[];

export const AUDIO_FEATURE_COMPONENTS = [
    "energy",
    "valence",
    "bpm",
    "danceability",
    "acousticness",
    "instrumentalness",
    "key",
] as const satisfies readonly SimilarityComponent[];

/**
 * Sums to exactly 1.00 and matches the historic hardcoded WEIGHTS constant —
 * with these defaults the emitted SQL parameters are numerically identical to
 * pre-mixer behavior (the backward-compat guarantee the tests pin). Lyric
 * knobs start at 0 so untouched users see identical results.
 */
export const DEFAULT_SIMILARITY_WEIGHTS: SimilarityWeights = {
    clap: 0.55,
    energy: 0.12,
    valence: 0.1,
    bpm: 0.08,
    danceability: 0.06,
    acousticness: 0.04,
    instrumentalness: 0.03,
    key: 0.02,
    lyricSemantic: 0,
    lyricSentiment: 0,
    lyricLexical: 0,
    lyricReading: 0,
};

const weightValue = z.number().min(0).max(1);

// Derived from SIMILARITY_COMPONENTS so the component list stays the single
// place a new dimension is declared (the schema can't silently miss one). The
// cast is sound: the entries are built directly from that const list.
const weightShape = Object.fromEntries(
    SIMILARITY_COMPONENTS.map((key) => [key, weightValue])
) as Record<SimilarityComponent, typeof weightValue>;

export const similarityWeightsSchema = z
    .object(weightShape)
    .strict()
    .refine((w) => Object.values(w).some((v) => v > 0), {
        message: "At least one weight must be greater than zero",
    });

/** Stored-JSON → weights; anything invalid (or null/absent) → defaults. */
export function resolveUserWeights(json: unknown): SimilarityWeights {
    const parsed = similarityWeightsSchema.safeParse(json);
    return parsed.success ? parsed.data : { ...DEFAULT_SIMILARITY_WEIGHTS };
}

export function isDefaultWeights(weights: SimilarityWeights): boolean {
    return SIMILARITY_COMPONENTS.every(
        (key) => weights[key] === DEFAULT_SIMILARITY_WEIGHTS[key]
    );
}

export interface NormalizedWeights {
    /** Weights scaled so the 12 components sum to 1. */
    norm: SimilarityWeights;
    /** clap + the 7 audio-feature weights (post-normalization). */
    audioSum: number;
    /** The 4 lyric weights (post-normalization); 0 ⇒ no lyric terms at all. */
    lyricSum: number;
}

/**
 * Normalize to Σ=1 and split into the audio / lyric mass used by the per-row
 * renormalization: score = (audio_terms + lyr_ok·lyr_terms) /
 * (audioSum + lyr_ok·lyricSum). When the input already sums to 1 (defaults
 * do, exactly), values pass through untouched — float-exactness is what makes
 * the "byte-identical SQL params with defaults" guarantee provable.
 */
export function splitAndNormalize(weights: SimilarityWeights): NormalizedWeights {
    const total = SIMILARITY_COMPONENTS.reduce((sum, key) => sum + weights[key], 0);
    const scale = Math.abs(total - 1) <= 1e-9 ? 1 : 1 / total;

    const norm = {} as SimilarityWeights;
    for (const key of SIMILARITY_COMPONENTS) {
        norm[key] = weights[key] * scale; // ×1 is exact in IEEE-754
    }

    const lyricSum = LYRIC_COMPONENTS.reduce((sum, key) => sum + norm[key], 0);
    const audioSum =
        norm.clap +
        AUDIO_FEATURE_COMPONENTS.reduce((sum, key) => sum + norm[key], 0);

    return { norm, audioSum, lyricSum };
}
