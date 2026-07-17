import assert from "node:assert/strict";
import test from "node:test";
import { buildVerdict, formatVerdict } from "../../components/vibe/verdict";
import { VERDICT_TEMPLATES } from "../../components/vibe/vibeCopy";
import type { XrayResponse } from "../../components/vibe/types";

function makeXray(overrides: Partial<XrayResponse> = {}): XrayResponse {
    return {
        a: { id: "a", title: "A", artist: "AA", albumId: null, coverUrl: null },
        b: { id: "b", title: "B", artist: "BB", albumId: null, coverUrl: null },
        overall: { similarity: 0.8, weights: "default" },
        clap: { available: true, similarity: 0.78 },
        features: [
            { key: "energy", a: 0.3, b: 0.8, similarity: 0.5 },
            { key: "valence", a: 0.7, b: 0.69, similarity: 0.99 },
            { key: "bpm", a: 72, b: 124, similarity: 0.6 },
            { key: "danceability", a: 0.5, b: 0.5, similarity: 1 },
            { key: "acousticness", a: 0.9, b: 0.2, similarity: 0.3 },
            { key: "instrumentalness", a: 0.1, b: 0.1, similarity: 1 },
        ],
        keys: {
            a: { key: "A", scale: "minor" },
            b: { key: "E", scale: "minor" },
            similarity: 0.85,
        },
        lyrics: {
            aStatus: "analyzed",
            bStatus: "analyzed",
            semanticSimilarity: 0.5,
            sentiment: { a: 0.2, b: 0.1, similarity: 0.95 },
            lexical: { a: 50, b: 60, similarity: 0.92 },
            reading: { a: 5, b: 6, similarity: 0.92 },
        },
        sharedNeighbors: [],
        ...overrides,
    };
}

function keysOf(xray: XrayResponse): string[] {
    return buildVerdict(xray).map((line) => line.key);
}

test("the user's original complaint gets explained: alike sound, diverging energy, tempo gap", () => {
    const lines = buildVerdict(makeXray());
    const keys = lines.map((l) => l.key);

    assert.equal(keys[0], "sonic-alike"); // 0.78 sits in the ≥0.70 tier
    assert.ok(keys.includes("gap-callout")); // energy gap 0.5 & acousticness 0.7
    assert.ok(keys.includes("tempo-apart")); // 52 BPM

    // Top-2 gaps only, largest first (acousticness 0.7 > energy 0.5)
    const gapLines = lines.filter((l) => l.key === "gap-callout");
    assert.equal(gapLines.length, 2);
    assert.equal(gapLines[0].values.percent, 70);
    assert.equal(gapLines[1].values.percent, 50);
});

test("sonic tiers map thresholds correctly", () => {
    assert.equal(keysOf(makeXray({ clap: { available: true, similarity: 0.9 } }))[0], "sonic-identical");
    assert.equal(keysOf(makeXray({ clap: { available: true, similarity: 0.55 } }))[0], "sonic-loose");
    assert.equal(keysOf(makeXray({ clap: { available: true, similarity: 0.2 } }))[0], "sonic-different");
    assert.equal(keysOf(makeXray({ clap: { available: false, similarity: null } }))[0], "sonic-unknown");
});

test("key relations: adjacent minor keys produce key-adjacent", () => {
    // A minor (8A) vs E minor (9A)
    const keys = keysOf(makeXray());
    assert.ok(keys.includes("key-adjacent"));
});

test("instrumental side yields lyrics-not-applicable and no lyric claims", () => {
    const keys = keysOf(
        makeXray({
            lyrics: {
                aStatus: "analyzed",
                bStatus: "instrumental",
                semanticSimilarity: null,
                sentiment: null,
                lexical: null,
                reading: null,
            },
        })
    );
    assert.ok(keys.includes("lyrics-not-applicable"));
    assert.ok(!keys.includes("lyrics-similar-themes"));
    assert.ok(!keys.includes("lyrics-opposite-polarity"));
});

test("irony detector: opposite lyric polarity fires at a 0.8 gap", () => {
    const xray = makeXray({
        lyrics: {
            aStatus: "analyzed",
            bStatus: "analyzed",
            semanticSimilarity: 0.8,
            sentiment: { a: 0.7, b: -0.3, similarity: 0.5 },
            lexical: null,
            reading: null,
        },
    });
    const keys = keysOf(xray);
    assert.ok(keys.includes("lyrics-opposite-polarity"));
    assert.ok(keys.includes("lyrics-similar-themes")); // 0.8 ≥ 0.75
});

test("every emitted key has a template, and formatting fills placeholders", () => {
    const lines = buildVerdict(makeXray());
    for (const line of lines) {
        assert.ok(
            VERDICT_TEMPLATES[line.key],
            `missing template for ${line.key}`
        );
        const rendered = formatVerdict(line, VERDICT_TEMPLATES);
        assert.ok(!/\{\w+\}/.test(rendered), `unfilled placeholder: ${rendered}`);
    }
});
