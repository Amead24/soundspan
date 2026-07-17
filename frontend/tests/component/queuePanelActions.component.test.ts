import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behaviour tests for the QueuePanel's click-through actions — the parts
 * renderToStaticMarkup (vibePanels.component.test.ts) can't drive: row click
 * → onPlayIndex with the ABSOLUTE queue index, the clear button → onClear,
 * and the clear button's empty-queue disable. Same happy-dom mount pattern
 * as mixerPanel.component.test.ts.
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

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueuePanel } from "../../components/vibe/QueuePanel";
import type { QueueItem } from "@/lib/queue-item";

const noop = () => undefined;

function queueTrack(id: string, title: string, artistName: string): QueueItem {
    return {
        id,
        title,
        artist: { name: artistName },
        album: { title: "" },
        duration: 200,
    } as unknown as QueueItem;
}

function mount(node: React.ReactElement): {
    container: HTMLElement;
    root: Root;
    unmount: () => void;
} {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(node);
    });
    return {
        container,
        root,
        unmount: () => {
            act(() => {
                root.unmount();
            });
            container.remove();
        },
    };
}

test("clicking an upcoming row jumps via onPlayIndex with the ABSOLUTE queue index", () => {
    const played: number[] = [];
    const { container, unmount } = mount(
        React.createElement(QueuePanel, {
            queue: [
                queueTrack("t0", "Past Song", "Past Artist"),
                queueTrack("t1", "Current Song", "Current Artist"),
                queueTrack("t2", "Next Song", "Next Artist"),
                queueTrack("t3", "Later Song", "Later Artist"),
            ],
            currentIndex: 1,
            onClose: noop,
            onReorder: noop,
            onPlayIndex: (i: number) => played.push(i),
        })
    );

    const later = container.querySelector<HTMLButtonElement>(
        '[aria-label="Play Later Song now"]'
    );
    assert.ok(later, "upcoming rows are jump buttons when onPlayIndex is wired");
    act(() => later!.click());
    // "Later Song" is upcoming row 1 → absolute index currentIndex + 1 + 1.
    assert.deepEqual(played, [3]);
    unmount();
});

test("the clear button fires onClear, and disables when nothing is UPCOMING", () => {
    let cleared = 0;
    const withUpcoming = mount(
        React.createElement(QueuePanel, {
            queue: [
                queueTrack("t1", "Current Song", "Current Artist"),
                queueTrack("t2", "Next Song", "Next Artist"),
            ],
            currentIndex: 0,
            onClose: noop,
            onReorder: noop,
            onClear: () => {
                cleared += 1;
            },
        })
    );
    const clear = withUpcoming.container.querySelector<HTMLButtonElement>(
        '[aria-label="Clear upcoming songs"]'
    );
    assert.ok(clear);
    assert.equal(clear!.disabled, false);
    act(() => clear!.click());
    assert.equal(cleared, 1);
    withUpcoming.unmount();

    // A playing song with an empty upcoming list: nothing to clear — the
    // button disables instead of offering a no-op (it never stops playback).
    const currentOnly = mount(
        React.createElement(QueuePanel, {
            queue: [queueTrack("t1", "Current Song", "Current Artist")],
            currentIndex: 0,
            onClose: noop,
            onReorder: noop,
            onClear: noop,
        })
    );
    const disabledClear = currentOnly.container.querySelector<HTMLButtonElement>(
        '[aria-label="Clear upcoming songs"]'
    );
    assert.ok(disabledClear);
    assert.equal(disabledClear!.disabled, true);
    currentOnly.unmount();
});
