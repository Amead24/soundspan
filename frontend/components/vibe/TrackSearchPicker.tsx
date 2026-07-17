"use client";

/**
 * TrackSearchPicker — the shared in-panel "find a track on the map" surface
 * used by the mixer's seed picker and both x-ray A/B pickers: a text input,
 * a dropdown of `searchMapTracks` matches, and optional one-tap shortcut
 * chips ("Use now playing", "Mixer seed"). Deliberately NOT SpotlightSearch:
 * that component owns combobox a11y, semantic search, and Esc semantics —
 * this is the lightweight in-panel variant.
 *
 * Callers render their own "picked" state and mount this only while nothing
 * is picked; picking clears the query so the next open starts fresh.
 */

import { useMemo, useState } from "react";
import { searchMapTracks } from "./mapSearch";
import type { MapTrack } from "./types";

export interface TrackSearchShortcut {
    id: string;
    label: string;
    /** Chip accent; the x-ray's "Mixer seed" chip is amber. */
    tone?: "indigo" | "amber";
}

const SHORTCUT_TONE_CLASS: Record<"indigo" | "amber", string> = {
    indigo: "bg-indigo-500/20 text-indigo-200 hover:bg-indigo-500/30",
    amber: "bg-amber-500/20 text-amber-200 hover:bg-amber-500/30",
};

export function TrackSearchPicker({
    tracks,
    limit,
    placeholder,
    ariaLabel,
    shortcuts = [],
    onPick,
}: {
    tracks: MapTrack[];
    /** Max dropdown rows (mixer uses 6, x-ray 5). */
    limit: number;
    placeholder: string;
    ariaLabel: string;
    /** One-tap pick chips rendered under the input; absent ids are skipped
     *  by the caller (pass only live shortcuts). */
    shortcuts?: TrackSearchShortcut[];
    onPick: (id: string) => void;
}) {
    const [query, setQuery] = useState("");
    const matches = useMemo(
        () => searchMapTracks(tracks, query, limit),
        [tracks, query, limit]
    );

    const pick = (id: string) => {
        onPick(id);
        setQuery("");
    };

    return (
        <div>
            <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder}
                aria-label={ariaLabel}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
            />
            {matches.length > 0 && (
                <ul className="mt-1 rounded-lg bg-black/40 border border-white/10 divide-y divide-white/5 max-h-44 overflow-y-auto">
                    {matches.map((t) => (
                        <li key={t.id}>
                            <button
                                type="button"
                                onClick={() => pick(t.id)}
                                className="w-full text-left px-2.5 py-1.5 hover:bg-white/10"
                            >
                                <span className="block text-sm text-white truncate">
                                    {t.title}
                                </span>
                                <span className="block text-xs text-gray-400 truncate">
                                    {t.artist}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {shortcuts.length > 0 && (
                <div className="mt-1.5 flex gap-1.5">
                    {shortcuts.map((s) => (
                        <button
                            key={`${s.id}-${s.label}`}
                            type="button"
                            onClick={() => pick(s.id)}
                            className={`flex-1 rounded-lg text-xs py-1.5 ${SHORTCUT_TONE_CLASS[s.tone ?? "indigo"]}`}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
