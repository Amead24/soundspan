/**
 * Pure scoring engine for the weight mixer: packs map-track scalars into
 * typed arrays once, then blends per-track similarity against a seed at
 * slider speed (15k tracks ≈ a few hundred k flops — sub-millisecond).
 *
 * Mirrors backend/src/services/similarityWeights.ts (component list,
 * defaults) and the §blend math: score = Σ(w·s·m) / Σ(w·m), where the four
 * lyric components share ONE availability mask and audio components are
 * always available via 0.5-neutral coalescing. Keep the two sides in sync.
 */

import {
    bpmSimilarity,
    featureCloseness,
    keySimilarity,
    lexicalCloseness,
    readingCloseness,
    sentimentCloseness,
} from "./simMath";
import type { MapTrack } from "./types";

export const MIXER_COMPONENTS = [
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

export type MixerComponent = (typeof MIXER_COMPONENTS)[number];
export type MixerWeights = Record<MixerComponent, number>;

/** Must equal backend DEFAULT_SIMILARITY_WEIGHTS. */
export const DEFAULT_WEIGHTS: MixerWeights = {
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

/** One-time packed scalar columns; NaN = missing. Index-aligned to the map
 * `tracks` array (the same order the mixer endpoint's arrays use). */
export interface PackedScalars {
    length: number;
    energy: Float32Array;
    valence: Float32Array;
    bpm: Float32Array;
    danceability: Float32Array;
    acousticness: Float32Array;
    instrumentalness: Float32Array;
    sentiment: Float32Array;
    lexicalDiversity: Float32Array;
    readingLevel: Float32Array;
    /** 1 when lyric analysis completed and not instrumental. */
    hasLyrics: Uint8Array;
    /** Raw key strings kept for keySimilarity (string compare is cheap
     * relative to the FP work, and preserves the SQL default-8B quirk). */
    keys: (string | null)[];
    keyScales: (string | null)[];
}

function packColumn(tracks: MapTrack[], pick: (t: MapTrack) => number | null | undefined): Float32Array {
    const out = new Float32Array(tracks.length);
    for (let i = 0; i < tracks.length; i++) {
        const v = pick(tracks[i]);
        out[i] = v == null ? NaN : v;
    }
    return out;
}

export function packTrackScalars(tracks: MapTrack[]): PackedScalars {
    const hasLyrics = new Uint8Array(tracks.length);
    const keys: (string | null)[] = new Array(tracks.length);
    const keyScales: (string | null)[] = new Array(tracks.length);
    for (let i = 0; i < tracks.length; i++) {
        hasLyrics[i] = tracks[i].hasLyrics ? 1 : 0;
        keys[i] = tracks[i].key ?? null;
        keyScales[i] = tracks[i].keyScale ?? null;
    }
    return {
        length: tracks.length,
        energy: packColumn(tracks, (t) => t.energy),
        valence: packColumn(tracks, (t) => t.valence),
        bpm: packColumn(tracks, (t) => t.bpm),
        danceability: packColumn(tracks, (t) => t.danceability),
        acousticness: packColumn(tracks, (t) => t.acousticness),
        instrumentalness: packColumn(tracks, (t) => t.instrumentalness),
        sentiment: packColumn(tracks, (t) => t.sentiment),
        lexicalDiversity: packColumn(tracks, (t) => t.lexicalDiversity),
        readingLevel: packColumn(tracks, (t) => t.readingLevel),
        hasLyrics,
        keys,
        keyScales,
    };
}

function nanToNull(v: number): number | null {
    return Number.isNaN(v) ? null : v;
}

/**
 * Blend per-track scores against the seed into `out` (allocation-free when
 * `out` is reused). NaN in `out[i]` means "no score" (no CLAP sim for the
 * pair — shouldn't happen for on-map tracks, but renderers must treat NaN
 * as unknown, not zero).
 *
 * clapSim/lyricSim come from GET /api/vibe/mixer/:seedId (null → NaN before
 * calling, or pass the arrays through toFloat32). Audio features always
 * participate via 0.5-neutral coalescing; the four lyric components share
 * one gate: lyricSim[i] present (the server already gates both sides as
 * lyric-analyzed + non-instrumental).
 */
export function computeScores(
    packed: PackedScalars,
    seedIndex: number,
    clapSim: Float32Array,
    lyricSim: Float32Array,
    weights: MixerWeights,
    out: Float32Array
): Float32Array {
    const n = packed.length;
    const sEnergy = nanToNull(packed.energy[seedIndex]);
    const sValence = nanToNull(packed.valence[seedIndex]);
    const sBpm = nanToNull(packed.bpm[seedIndex]);
    const sDance = nanToNull(packed.danceability[seedIndex]);
    const sAcoustic = nanToNull(packed.acousticness[seedIndex]);
    const sInstr = nanToNull(packed.instrumentalness[seedIndex]);
    const sSent = packed.sentiment[seedIndex];
    const sLex = packed.lexicalDiversity[seedIndex];
    const sRead = packed.readingLevel[seedIndex];
    const sKey = packed.keys[seedIndex];
    const sScale = packed.keyScales[seedIndex];

    const w = weights;
    const lyricWeight =
        w.lyricSemantic + w.lyricSentiment + w.lyricLexical + w.lyricReading;
    const audioFeatureWeight =
        w.energy + w.valence + w.bpm + w.danceability + w.acousticness +
        w.instrumentalness + w.key;

    for (let i = 0; i < n; i++) {
        const clap = clapSim[i];
        let num = 0;
        let den = 0;

        if (!Number.isNaN(clap)) {
            num += w.clap * Math.max(0, clap);
            den += w.clap;
        }

        num +=
            w.energy * featureCloseness(nanToNull(packed.energy[i]), sEnergy) +
            w.valence * featureCloseness(nanToNull(packed.valence[i]), sValence) +
            w.bpm * bpmSimilarity(nanToNull(packed.bpm[i]), sBpm) +
            w.danceability * featureCloseness(nanToNull(packed.danceability[i]), sDance) +
            w.acousticness * featureCloseness(nanToNull(packed.acousticness[i]), sAcoustic) +
            w.instrumentalness * featureCloseness(nanToNull(packed.instrumentalness[i]), sInstr) +
            w.key * keySimilarity(packed.keys[i], packed.keyScales[i], sKey, sScale);
        den += audioFeatureWeight;

        const lyric = lyricSim[i];
        if (lyricWeight > 0 && !Number.isNaN(lyric)) {
            let lyricScore = w.lyricSemantic * Math.max(0, lyric);
            // Scalar gates ride the same mask; guard NaN individually since
            // an older analysis version might miss one column.
            if (!Number.isNaN(packed.sentiment[i]) && !Number.isNaN(sSent)) {
                lyricScore += w.lyricSentiment * sentimentCloseness(packed.sentiment[i], sSent);
            }
            if (!Number.isNaN(packed.lexicalDiversity[i]) && !Number.isNaN(sLex)) {
                lyricScore += w.lyricLexical * lexicalCloseness(packed.lexicalDiversity[i], sLex);
            }
            if (!Number.isNaN(packed.readingLevel[i]) && !Number.isNaN(sRead)) {
                lyricScore += w.lyricReading * readingCloseness(packed.readingLevel[i], sRead);
            }
            num += lyricScore;
            den += lyricWeight;
        }

        out[i] = den > 0 ? num / den : NaN;
    }

    return out;
}

/** Convert the endpoint's (number|null)[] into a NaN-marked Float32Array. */
export function toFloat32(values: Array<number | null>): Float32Array {
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        out[i] = v == null ? NaN : v;
    }
    return out;
}

/** Indices of the top-n scores (descending), skipping NaN and excludeIndex. */
export function topNIndices(
    scores: Float32Array,
    n: number,
    excludeIndex = -1
): number[] {
    const top: number[] = [];
    for (let i = 0; i < scores.length; i++) {
        if (i === excludeIndex || Number.isNaN(scores[i])) continue;
        // Insertion into a small sorted list — O(len·n), fine for n ≤ ~50
        let lo = 0;
        let hi = top.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (scores[top[mid]] >= scores[i]) lo = mid + 1;
            else hi = mid;
        }
        if (lo < n) {
            top.splice(lo, 0, i);
            if (top.length > n) top.pop();
        }
    }
    return top;
}

/**
 * Precomputed hex color ramp for score → dot color (indexing a string array
 * per dot keeps the render loop allocation-free). Low = muted slate, high =
 * hot amber; visually distinct from all 7 mood colors so "mixer mode" reads
 * as its own lens.
 */
export function buildScoreColorLut(steps = 64): string[] {
    const low = { r: 0x47, g: 0x55, b: 0x69 }; // #475569
    const high = { r: 0xf5, g: 0x9e, b: 0x0b }; // #f59e0b
    const lut: string[] = new Array(steps);
    for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        const r = Math.round(low.r + (high.r - low.r) * t);
        const g = Math.round(low.g + (high.g - low.g) * t);
        const b = Math.round(low.b + (high.b - low.b) * t);
        lut[i] = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
    }
    return lut;
}

/** Map a score (0..1) to a LUT index; NaN → -1 (caller renders "unknown"). */
export function scoreToLutIndex(score: number, steps = 64): number {
    if (Number.isNaN(score)) return -1;
    return Math.min(steps - 1, Math.max(0, Math.floor(score * steps)));
}
