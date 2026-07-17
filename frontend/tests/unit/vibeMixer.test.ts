import assert from "node:assert/strict";
import test from "node:test";
import {
    buildScoreColorLut,
    computeScores,
    DEFAULT_WEIGHTS,
    MIXER_COMPONENTS,
    packTrackScalars,
    scoreToLutIndex,
    toFloat32,
    topNIndices,
    type MixerWeights,
} from "../../components/vibe/vibeMixer";
import type { MapTrack } from "../../components/vibe/types";

function makeTrack(id: string, overrides: Partial<MapTrack> = {}): MapTrack {
    return {
        id,
        x: 0.5,
        y: 0.5,
        title: id,
        artist: "artist",
        artistId: "artist-1",
        albumId: "album-1",
        coverUrl: null,
        dominantMood: "neutral",
        moodHappy: 0,
        energy: 0.5,
        valence: 0.5,
        bpm: 120,
        danceability: 0.5,
        acousticness: 0.5,
        instrumentalness: 0.5,
        key: "C",
        keyScale: "major",
        sentiment: null,
        lexicalDiversity: null,
        readingLevel: null,
        hasLyrics: false,
        ...overrides,
    };
}

function weights(overrides: Partial<MixerWeights> = {}): MixerWeights {
    return { ...DEFAULT_WEIGHTS, ...overrides };
}

test("defaults sum to 1 and match the backend component list", () => {
    const total = MIXER_COMPONENTS.reduce((s, k) => s + DEFAULT_WEIGHTS[k], 0);
    assert.equal(total, 1);
    assert.equal(MIXER_COMPONENTS.length, 12);
});

test("identical tracks with full clap sim score 1", () => {
    const tracks = [makeTrack("seed"), makeTrack("twin")];
    const packed = packTrackScalars(tracks);
    const out = new Float32Array(2);

    computeScores(
        packed,
        0,
        toFloat32([1, 1]),
        toFloat32([null, null]),
        weights(),
        out
    );

    assert.ok(Math.abs(out[1] - 1) < 1e-6, `expected ~1, got ${out[1]}`);
});

test("lyric weights renormalize away for pairs without lyrics", () => {
    // Two identical-audio tracks; one comparison has lyric data, one doesn't.
    // With lyric weight in play, the no-lyrics pair must still score on its
    // audio terms alone (renormalized), not be dragged down by unfillable
    // lyric weight.
    const tracks = [
        makeTrack("seed", { hasLyrics: true, sentiment: 0.5, lexicalDiversity: 50, readingLevel: 5 }),
        makeTrack("with-lyrics", { hasLyrics: true, sentiment: 0.5, lexicalDiversity: 50, readingLevel: 5 }),
        makeTrack("no-lyrics"),
    ];
    const packed = packTrackScalars(tracks);
    const out = new Float32Array(3);

    computeScores(
        packed,
        0,
        toFloat32([1, 1, 1]),
        toFloat32([1, 1, null]), // identical lyric sims where present
        weights({ lyricSemantic: 0.5 }),
        out
    );

    // Both should be perfect: the lyric pair via lyric+audio, the no-lyric
    // pair via renormalized audio-only terms.
    assert.ok(Math.abs(out[1] - 1) < 1e-6, `lyric pair: ${out[1]}`);
    assert.ok(Math.abs(out[2] - 1) < 1e-6, `no-lyric pair: ${out[2]}`);
});

test("a lyric-weighted mix actually separates lyric-distant tracks", () => {
    const tracks = [
        makeTrack("seed", { hasLyrics: true, sentiment: 0.9, lexicalDiversity: 50, readingLevel: 5 }),
        makeTrack("same-words", { hasLyrics: true, sentiment: 0.9, lexicalDiversity: 50, readingLevel: 5 }),
        makeTrack("opposite-words", { hasLyrics: true, sentiment: -0.9, lexicalDiversity: 50, readingLevel: 5 }),
    ];
    const packed = packTrackScalars(tracks);
    const out = new Float32Array(3);

    computeScores(
        packed,
        0,
        toFloat32([1, 1, 1]),
        toFloat32([1, 0.95, 0.2]),
        weights({ lyricSemantic: 0.4, lyricSentiment: 0.4 }),
        out
    );

    assert.ok(out[1] > out[2], `expected ${out[1]} > ${out[2]}`);
});

test("all-zero weight denominator yields NaN (unknown), not 0", () => {
    const tracks = [makeTrack("seed"), makeTrack("other")];
    const packed = packTrackScalars(tracks);
    const out = new Float32Array(2);
    const zero = Object.fromEntries(
        MIXER_COMPONENTS.map((k) => [k, 0])
    ) as MixerWeights;

    computeScores(packed, 0, toFloat32([1, 1]), toFloat32([null, null]), zero, out);

    assert.ok(Number.isNaN(out[1]));
});

test("topNIndices returns descending scores, skipping NaN and the seed", () => {
    const scores = new Float32Array([0.9, NaN, 0.7, 0.95, 0.1]);
    assert.deepEqual(topNIndices(scores, 2, 0), [3, 2]);
    assert.deepEqual(topNIndices(scores, 10, -1), [3, 0, 2, 4]);
});

test("color LUT is precomputed hex strings; NaN maps to sentinel -1", () => {
    const lut = buildScoreColorLut(64);
    assert.equal(lut.length, 64);
    assert.equal(lut[0], "#475569");
    assert.equal(lut[63], "#f59e0b");
    assert.ok(lut.every((c) => /^#[0-9a-f]{6}$/.test(c)));
    assert.equal(scoreToLutIndex(NaN), -1);
    assert.equal(scoreToLutIndex(0), 0);
    assert.equal(scoreToLutIndex(1), 63);
    assert.equal(scoreToLutIndex(2), 63); // clamped
});
