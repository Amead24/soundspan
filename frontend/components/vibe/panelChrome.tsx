"use client";

/**
 * panelChrome — the shared chrome for every vibe aux panel (Travel, Journey,
 * Alchemy, Queue, Mixer, X-ray).
 *
 * The class/style constants used to live in TravelPanel.tsx and were opt-in,
 * which is exactly how two panels shipped as mis-anchored mobile sheets (they
 * adopted the class but forgot the paired style). The `<VibePanel>` wrapper
 * makes that omission impossible: it owns the container div, the header row,
 * and the close button, so a panel body only supplies content.
 *
 * VibePanel also owns the panels' focus contract:
 * - on mount, focus moves to the panel heading (tabIndex -1), so keyboard and
 *   screen-reader users land where the panel starts;
 * - on unmount, focus returns to the element that had it when the panel
 *   opened (the invoking toolbar toggle), instead of dropping to <body> —
 *   covering ✕-click, Esc (handled globally in VibeMap), and programmatic
 *   closes alike.
 */

import { X } from "lucide-react";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/** Shared glass surface for the F2 mode panels: floats over the viz, sits to
 *  the left of the top-right ViewControls stack on desktop, and drops to a
 *  bottom sheet below sm. Pair with VIBE_PANEL_STYLE, which anchors the sheet
 *  above the mobile mini player (--vibe-binset, 0px on desktop/fullscreen). */
export const VIBE_PANEL_CLASS =
    "absolute z-40 inset-x-0 sm:inset-x-auto sm:right-20 sm:top-3 " +
    "sm:w-72 max-h-[75%] sm:max-h-[calc(100%-1.5rem)] overflow-y-auto " +
    "bg-black/60 border border-white/10 rounded-t-xl sm:rounded-xl " +
    "backdrop-blur-md px-3 py-3 shadow-lg";

/** Bottom anchor for the mode panels (was `bottom-0`; see VIBE_PANEL_CLASS). */
export const VIBE_PANEL_STYLE: CSSProperties = {
    bottom: "var(--vibe-binset, 0px)",
};

/** Close (✕) button with a humane ≥40px hit area, negatively margined so it
 *  doesn't inflate the panel header. */
export const PANEL_CLOSE_CLASS =
    "ml-auto -mr-1.5 -my-1 inline-flex items-center justify-center w-10 h-10 " +
    "rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60";

export interface VibePanelProps {
    /** Heading content (may include inline extras, e.g. Alchemy's counter). */
    title: ReactNode;
    /** Optional leading icon, rendered inside the heading. */
    icon?: ReactNode;
    /** Optional controls rendered between the heading and the ✕ (e.g. the
     *  mixer's reset button). */
    headerExtra?: ReactNode;
    onClose: () => void;
    /** aria-label for the ✕ button (e.g. "Exit travel (Esc)"). */
    closeLabel: string;
    /** Tooltip for the ✕; defaults to closeLabel. */
    closeTitle?: string;
    /** Value for the data-vibe-panel attribute (mode panels). */
    dataVibePanel?: string;
    /** Value for the data-testid attribute (mixer / x-ray idiom). */
    testId?: string;
    children: ReactNode;
}

export function VibePanel({
    title,
    icon,
    headerExtra,
    onClose,
    closeLabel,
    closeTitle,
    dataVibePanel,
    testId,
    children,
}: VibePanelProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const headingRef = useRef<HTMLHeadingElement | null>(null);
    const invokerRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        // Capture the invoker BEFORE stealing focus, restore it on close if
        // focus would otherwise be lost (on <body>, gone, or still inside the
        // unmounting panel — cleanup timing differs across React versions).
        invokerRef.current =
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
        headingRef.current?.focus();
        const root = rootRef.current;
        return () => {
            const invoker = invokerRef.current;
            const active = document.activeElement;
            const focusLost =
                active === null ||
                active === document.body ||
                (root !== null && root.contains(active));
            if (invoker && invoker.isConnected && focusLost) {
                invoker.focus();
            }
        };
    }, []);

    return (
        <div
            ref={rootRef}
            className={VIBE_PANEL_CLASS}
            style={VIBE_PANEL_STYLE}
            {...(dataVibePanel ? { "data-vibe-panel": dataVibePanel } : {})}
            {...(testId ? { "data-testid": testId } : {})}
        >
            <div className="flex items-center gap-2 mb-2">
                <h3
                    ref={headingRef}
                    tabIndex={-1}
                    className="flex items-center gap-1.5 text-sm font-semibold text-white outline-none"
                >
                    {icon}
                    {title}
                </h3>
                {headerExtra}
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={closeLabel}
                    title={closeTitle ?? closeLabel}
                    className={PANEL_CLOSE_CLASS}
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
            {children}
        </div>
    );
}
