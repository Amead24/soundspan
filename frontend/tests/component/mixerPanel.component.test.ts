import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behaviour tests for MixerPanel: seed picking via in-panel search and
 * "use now playing" (deliberately no dot-click semantics), slider →
 * setWeight, force mode/strength controls, and ranked-row → onLocate.
 * MixerPanel is fully presentational (state injected via the MixerState
 * prop), so no module boundary mocks are needed — real mount via happy-dom,
 * same pattern as the other vibe component suites.
 */

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        /* best-effort teardown */
    }
});

import { MixerPanel } from "../../components/vibe/MixerPanel";
import { DEFAULT_WEIGHTS } from "../../components/vibe/vibeMixer";
import type { MixerState } from "../../components/vibe/useMixer";
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
        hasLyrics: false,
    };
}

const tracks = [
    mapTrack("t1", "Aurora Drive", "Nightwave"),
    mapTrack("t2", "Morning Frost", "Nightwave"),
    mapTrack("t3", "Completely Different", "Someone Else"),
];

const calls: {
    setSeed: Array<string | null>;
    setWeight: Array<[string, number]>;
    reset: number;
    setForceMode: string[];
    setForceStrength: number[];
    locate: string[];
    close: number;
} = {
    setSeed: [],
    setWeight: [],
    reset: 0,
    setForceMode: [],
    setForceStrength: [],
    locate: [],
    close: 0,
};

beforeEach(() => {
    calls.setSeed.length = 0;
    calls.setWeight.length = 0;
    calls.reset = 0;
    calls.setForceMode.length = 0;
    calls.setForceStrength.length = 0;
    calls.locate.length = 0;
    calls.close = 0;
});

function mixerState(overrides: Partial<MixerState> = {}): MixerState {
    return {
        seedId: null,
        seedIndex: null,
        seedTrack: null,
        setSeed: (id) => calls.setSeed.push(id),
        weights: { ...DEFAULT_WEIGHTS },
        setWeight: (key, value) => calls.setWeight.push([key, value]),
        resetWeights: () => calls.reset++,
        scores: null,
        topTracks: [],
        componentsLoading: false,
        componentsError: null,
        lyricCoverage: { analyzed: 2, total: 3 },
        forceMode: "off",
        setForceMode: (mode) => calls.setForceMode.push(mode),
        forceStrength: 0.7,
        setForceStrength: (value) => calls.setForceStrength.push(value),
        ...overrides,
    };
}

async function mountPanel(state: MixerState) {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            React.createElement(MixerPanel, {
                mixer: state,
                tracks,
                nowPlayingId: "t2",
                onLocate: (id: string) => calls.locate.push(id),
                onClose: () => calls.close++,
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
    // React tracks the value setter — go through the native setter so the
    // change event isn't swallowed as a no-op.
    const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value"
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("seed search lists matches and picking one sets the seed", async () => {
    const { container, act, unmount } = await mountPanel(mixerState());

    const input = container.querySelector<HTMLInputElement>(
        'input[placeholder="Pick a seed track…"]'
    );
    assert.ok(input);
    await act(async () => setInputValue(input!, "aurora"));

    const match = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Aurora Drive")
    );
    assert.ok(match, "search match rendered");
    await act(async () => match!.click());

    assert.deepEqual(calls.setSeed, ["t1"]);
    await unmount();
});

test("'Use now playing' seeds with the on-map now-playing id", async () => {
    const { container, act, unmount } = await mountPanel(mixerState());

    const btn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "Use now playing"
    );
    assert.ok(btn);
    await act(async () => btn!.click());

    assert.deepEqual(calls.setSeed, ["t2"]);
    await unmount();
});

test("dragging a slider reports the component key and value", async () => {
    const { container, act, unmount } = await mountPanel(mixerState());

    const slider = container.querySelector<HTMLInputElement>(
        'input[aria-label="Lyrics: meaning"]'
    );
    assert.ok(slider, "lyricSemantic slider rendered");
    await act(async () => setInputValue(slider!, "0.4"));

    assert.deepEqual(calls.setWeight, [["lyricSemantic", 0.4]]);
    await unmount();
});

test("force radios: disabled without scores, active with; strength slider reports", async () => {
    // Without scores: attract/repel disabled
    let mounted = await mountPanel(mixerState());
    const attract = Array.from(
        mounted.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ).find((b) => b.textContent === "attract");
    assert.ok(attract);
    assert.equal(attract!.disabled, true);
    await mounted.unmount();

    // With scores + a seed: clickable
    mounted = await mountPanel(
        mixerState({
            seedId: "t1",
            seedIndex: 0,
            seedTrack: tracks[0],
            scores: new Float32Array([1, 0.5, 0.2]),
            forceMode: "off",
        })
    );
    const attract2 = Array.from(
        mounted.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ).find((b) => b.textContent === "attract");
    assert.ok(attract2);
    assert.equal(attract2!.disabled, false);
    await mounted.act(async () => attract2!.click());
    assert.deepEqual(calls.setForceMode, ["attract"]);
    await mounted.unmount();
});

test("force radios rove: one Tab stop, arrows move selection, disabled skipped", async () => {
    // With scores: arrows from "off" select the next enabled mode.
    let mounted = await mountPanel(
        mixerState({
            seedId: "t1",
            seedIndex: 0,
            seedTrack: tracks[0],
            scores: new Float32Array([1, 0.5, 0.2]),
            forceMode: "off",
        })
    );
    let radios = Array.from(
        mounted.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    );
    // Roving tabindex: exactly the checked option is the Tab stop.
    assert.deepEqual(
        radios.map((r) => r.tabIndex),
        [0, -1, -1]
    );
    await mounted.act(async () =>
        radios[0].dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
        )
    );
    assert.deepEqual(calls.setForceMode, ["attract"]);
    await mounted.unmount();

    // Without scores: attract/repel are disabled, so arrows go nowhere.
    calls.setForceMode.length = 0;
    mounted = await mountPanel(mixerState({ forceMode: "off" }));
    radios = Array.from(
        mounted.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    );
    await mounted.act(async () =>
        radios[0].dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
        )
    );
    assert.deepEqual(calls.setForceMode, []);
    await mounted.unmount();
});

test("ranked rows fly to the track; close button closes", async () => {
    const state = mixerState({
        seedId: "t1",
        seedIndex: 0,
        seedTrack: tracks[0],
        scores: new Float32Array([1, 0.9, 0.4]),
        topTracks: [
            { track: tracks[1], index: 1, score: 0.9 },
            { track: tracks[2], index: 2, score: 0.4 },
        ],
    });
    const { container, act, unmount } = await mountPanel(state);

    const row = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Morning Frost")
    );
    assert.ok(row, "ranked row rendered");
    assert.ok(row!.textContent?.includes("90%"), "blend percent shown");
    await act(async () => row!.click());
    assert.deepEqual(calls.locate, ["t2"]);

    const close = container.querySelector<HTMLButtonElement>(
        '[aria-label="Close mixer"]'
    );
    await act(async () => close!.click());
    assert.equal(calls.close, 1);
    await unmount();
});

test("lyric coverage line is visible so low-coverage libraries aren't a silent no-op", async () => {
    const { container, unmount } = await mountPanel(mixerState());
    assert.ok(container.textContent?.includes("analyzed for 2 of 3 songs"));
    await unmount();
});
