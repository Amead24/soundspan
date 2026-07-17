import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behaviour tests for the shared VibePanel chrome: the paired
 * class+style contract (the D1 regression class — panels adopting the class
 * but forgetting the bottom-anchor style) and the focus contract (initial
 * focus on the heading; focus returned to the invoking control on close).
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
import { renderToStaticMarkup } from "react-dom/server";
import { VibePanel } from "../../components/vibe/panelChrome";

function mount(node: React.ReactElement): {
    container: HTMLElement;
    root: Root;
} {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(node);
    });
    return { container, root };
}

test("renders the paired chrome: bottom-anchor style, data attrs, labeled close button", () => {
    let closed = 0;
    const { container, root } = mount(
        React.createElement(
            VibePanel,
            {
                title: "Travel",
                onClose: () => {
                    closed += 1;
                },
                closeLabel: "Exit travel (Esc)",
                dataVibePanel: "travel",
            },
            React.createElement("p", null, "body")
        )
    );

    const panel = container.querySelector<HTMLElement>(
        '[data-vibe-panel="travel"]'
    );
    assert.ok(panel, "panel root carries the data-vibe-panel attribute");
    // The D1 regression: the class alone has no vertical anchor below sm —
    // the paired style MUST ride along on every panel. Pinned via SSR markup
    // because happy-dom's CSSOM silently drops var() values for `bottom`.
    const markup = renderToStaticMarkup(
        React.createElement(
            VibePanel,
            {
                title: "Travel",
                onClose: () => {},
                closeLabel: "Exit travel (Esc)",
                dataVibePanel: "travel",
            },
            React.createElement("p", null, "body")
        )
    );
    assert.match(markup, /bottom:\s*var\(--vibe-binset,\s*0px\)/);

    const heading = panel!.querySelector("h3");
    assert.ok(heading, "title renders as a heading");
    assert.equal(heading!.textContent, "Travel");

    const close = panel!.querySelector<HTMLButtonElement>(
        '[aria-label="Exit travel (Esc)"]'
    );
    assert.ok(close, "close button carries the aria-label");
    close!.click();
    assert.equal(closed, 1);

    act(() => {
        root.unmount();
    });
});

test("focus moves to the heading on open and returns to the invoker on close", () => {
    // Simulate the real flow: a toolbar toggle has focus, then the panel opens.
    const invoker = document.createElement("button");
    invoker.textContent = "Open panel";
    document.body.appendChild(invoker);
    invoker.focus();
    assert.equal(document.activeElement, invoker);

    const { container, root } = mount(
        React.createElement(
            VibePanel,
            {
                title: "Queue",
                onClose: () => {},
                closeLabel: "Close queue",
                dataVibePanel: "queue",
            },
            React.createElement("p", null, "body")
        )
    );

    const heading = container.querySelector<HTMLElement>("h3");
    assert.equal(
        document.activeElement,
        heading,
        "initial focus lands on the panel heading"
    );

    act(() => {
        root.unmount();
    });
    assert.equal(
        document.activeElement,
        invoker,
        "closing the panel returns focus to the invoking control"
    );

    invoker.remove();
});

test("focus is NOT stolen back to the invoker when the user moved on before close", () => {
    const invoker = document.createElement("button");
    document.body.appendChild(invoker);
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    invoker.focus();

    const { root } = mount(
        React.createElement(
            VibePanel,
            {
                title: "Queue",
                onClose: () => {},
                closeLabel: "Close queue",
            },
            React.createElement("p", null, "body")
        )
    );

    // The user tabbed away from the map surface entirely.
    elsewhere.focus();

    act(() => {
        root.unmount();
    });
    assert.equal(
        document.activeElement,
        elsewhere,
        "focus outside the panel is left alone on close"
    );

    invoker.remove();
    elsewhere.remove();
});
