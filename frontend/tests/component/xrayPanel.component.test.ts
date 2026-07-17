import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behaviour tests for XrayPanel: A/B picking (search + shortcuts), the fetch
 * on both-picked, verdict + component rendering from a fixture response, and
 * the instrumental degradation state. `@/lib/api` is boundary-mocked; the
 * verdict/simMath/vibeCopy modules are real (pure).
 */

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const xrayCalls: string[][] = [];
let xrayResponse: unknown = null;

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getVibeXray: async (a: string, b: string) => {
                xrayCalls.push([a, b]);
                if (xrayResponse == null) throw new Error("no fixture");
                return xrayResponse;
            },
        },
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        /* best-effort teardown */
    }
});

import type { MapTrack } from "../../components/vibe/types";

function mapTrack(id: string, title: string, artist: string): MapTrack {
    return {
        id,
        x: 0.5,
        y: 0.5,
        title,
        artist,
        artistId: `ar-${id}`,
        albumId: `al-${id}`,
        coverUrl: null,
        dominantMood: "moodHappy",
        moodHappy: 0.5,
        energy: 0.5,
        valence: 0.5,
        hasLyrics: true,
    };
}

const tracks = [
    mapTrack("t1", "Aurora Drive", "Nightwave"),
    mapTrack("t2", "Morning Frost", "Nightwave"),
];

function fixture(overrides: Record<string, unknown> = {}) {
    return {
        a: { id: "t1", title: "Aurora Drive", artist: "Nightwave", albumId: "al-t1", coverUrl: null },
        b: { id: "t2", title: "Morning Frost", artist: "Nightwave", albumId: "al-t2", coverUrl: null },
        overall: { similarity: 0.72, weights: "default" },
        clap: { available: true, similarity: 0.88 },
        features: [
            { key: "energy", a: 0.3, b: 0.8, similarity: 0.5 },
            { key: "valence", a: 0.7, b: 0.69, similarity: 0.99 },
            { key: "bpm", a: 72, b: 124, similarity: 0.75 },
            { key: "danceability", a: 0.5, b: 0.5, similarity: 1 },
            { key: "acousticness", a: 0.5, b: 0.5, similarity: 1 },
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
            semanticSimilarity: 0.81,
            sentiment: { a: 0.6, b: -0.4, similarity: 0.5 },
            lexical: { a: 60, b: 40, similarity: 0.83 },
            reading: { a: 5, b: 7, similarity: 0.83 },
        },
        sharedNeighbors: [
            { id: "n1", title: "Shared Song", artist: "Someone", albumId: null, coverUrl: null },
        ],
        ...overrides,
    };
}

const locateCalls: string[] = [];

beforeEach(() => {
    xrayCalls.length = 0;
    locateCalls.length = 0;
    xrayResponse = fixture();
});

async function mountPanel(props: Partial<{
    nowPlayingId: string | null;
    mixerSeedId: string | null;
}> = {}) {
    const { XrayPanel } = await import("../../components/vibe/XrayPanel");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            React.createElement(XrayPanel, {
                tracks,
                nowPlayingId: props.nowPlayingId ?? "t1",
                mixerSeedId: props.mixerSeedId ?? null,
                onLocate: (id: string) => locateCalls.push(id),
                onClose: () => undefined,
            })
        );
    });
    return {
        container,
        act,
        unmount: async () => {
            await act(async () => root.unmount());
            container.remove();
        },
    };
}

function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value"
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function pickBoth(mounted: Awaited<ReturnType<typeof mountPanel>>) {
    const { container, act } = mounted;
    // A via "Now playing" shortcut
    const nowPlaying = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "Now playing"
    );
    assert.ok(nowPlaying, "now playing shortcut rendered");
    await act(async () => nowPlaying!.click());

    // B via search
    const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Pick song B"]'
    );
    assert.ok(input, "B picker rendered");
    await act(async () => setInputValue(input!, "morning"));
    const match = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Morning Frost")
    );
    assert.ok(match, "B search match rendered");
    await act(async () => match!.click());
    // allow the fetch effect + state commit to flush
    await act(async () => {
        await Promise.resolve();
    });
}

test("picking A and B fetches the comparison and renders the breakdown", async () => {
    const mounted = await mountPanel();
    await pickBoth(mounted);

    assert.deepEqual(xrayCalls, [["t1", "t2"]]);
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes("72%"), "overall percent shown");
    assert.ok(text.includes("88% sonic"), "clap percent shown");
    // Camelot badges from simMath (A minor = 8A, E minor = 9A)
    assert.ok(text.includes("8A") && text.includes("9A"), "camelot badges");
    // Verdicts composed from the fixture: sonic-identical tier + the
    // opposite-polarity irony line (|0.6 - -0.4| = 1.0 ≥ 0.8)
    assert.ok(
        text.includes("Nearly identical sonic texture"),
        "sonic verdict rendered"
    );
    assert.ok(
        text.includes("Opposite emotional polarity"),
        "irony verdict rendered"
    );
    // Lyric block numbers
    assert.ok(text.includes("Themes match"), "semantic line");
    await mounted.unmount();
});

test("shared-neighbor chips fly to the track", async () => {
    const mounted = await mountPanel();
    await pickBoth(mounted);

    const chip = Array.from(mounted.container.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Shared Song")
    );
    assert.ok(chip, "neighbor chip rendered");
    await mounted.act(async () => chip!.click());
    assert.deepEqual(locateCalls, ["n1"]);
    await mounted.unmount();
});

test("instrumental side renders the lyric-dials-don't-apply state", async () => {
    xrayResponse = fixture({
        lyrics: {
            aStatus: "analyzed",
            bStatus: "instrumental",
            semanticSimilarity: null,
            sentiment: null,
            lexical: null,
            reading: null,
        },
    });
    const mounted = await mountPanel();
    await pickBoth(mounted);

    const text = mounted.container.textContent ?? "";
    assert.ok(
        text.includes("Lyric dials don't apply here"),
        "not-applicable copy rendered"
    );
    assert.ok(!text.includes("Themes match"), "no lyric claims");
    await mounted.unmount();
});

test("mixer-seed shortcut appears when a seed exists and picks it", async () => {
    const mounted = await mountPanel({ mixerSeedId: "t2", nowPlayingId: null });
    const seedBtn = Array.from(
        mounted.container.querySelectorAll("button")
    ).find((b) => b.textContent === "Mixer seed");
    assert.ok(seedBtn, "mixer seed shortcut rendered");
    await mounted.act(async () => seedBtn!.click());
    // Picked as A; no fetch yet with only one side picked
    assert.equal(xrayCalls.length, 0);
    assert.ok(mounted.container.textContent?.includes("Morning Frost"));
    await mounted.unmount();
});

test("fetch failure shows the error state, not a crash", async () => {
    xrayResponse = null; // mock throws
    const mounted = await mountPanel();
    await pickBoth(mounted);

    assert.ok(
        mounted.container.textContent?.includes(
            "Couldn't compare those two tracks"
        )
    );
    await mounted.unmount();
});
