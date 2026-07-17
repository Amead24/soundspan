"use client";

/**
 * MixerPanel — the weight-mixer aux surface: pick a seed track (in-panel
 * search or "use now playing" — deliberately NO new dot-click semantics),
 * drag per-dimension sliders to re-blend similarity live (the map recolors
 * via MapCanvas's score props), toggle the attract/repel force, and browse
 * the ranked top matches. All state lives in useMixer; this is presentation.
 */

import { useMemo, useState } from "react";
import { Loader2, LocateFixed, Music2, RotateCcw, X } from "lucide-react";
import { searchMapTracks } from "./mapSearch";
import type { MixerState } from "./useMixer";
import type { MapTrack } from "./types";
import type { MixerComponent } from "./vibeMixer";
import { DIMENSION_COPY } from "./vibeCopy";
import { VIBE_PANEL_CLASS } from "./TravelPanel";

const AUDIO_GROUP: MixerComponent[] = [
    "clap",
    "energy",
    "valence",
    "bpm",
    "danceability",
    "acousticness",
    "instrumentalness",
    "key",
];
const LYRIC_GROUP: MixerComponent[] = [
    "lyricSemantic",
    "lyricSentiment",
    "lyricLexical",
    "lyricReading",
];

export interface MixerPanelProps {
    mixer: MixerState;
    tracks: MapTrack[];
    /** Now-playing track id when it is present on the map, else null. */
    nowPlayingId: string | null;
    onLocate: (id: string) => void;
    onClose: () => void;
}

function WeightSlider({
    componentKey,
    value,
    onChange,
}: {
    componentKey: MixerComponent;
    value: number;
    onChange: (key: MixerComponent, value: number) => void;
}) {
    const copy = DIMENSION_COPY[componentKey];
    return (
        <label className="block" title={copy.knobHint}>
            <span className="flex items-center justify-between text-xs text-gray-300">
                <span>{copy.label}</span>
                <span className="tabular-nums text-gray-400">
                    {Math.round(value * 100)}
                </span>
            </span>
            <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={value}
                aria-label={copy.label}
                onChange={(e) => onChange(componentKey, Number(e.target.value))}
                className="w-full accent-indigo-400 h-1.5"
            />
        </label>
    );
}

export function MixerPanel({
    mixer,
    tracks,
    nowPlayingId,
    onLocate,
    onClose,
}: MixerPanelProps) {
    const [query, setQuery] = useState("");
    const matches = useMemo(
        () => (mixer.seedId ? [] : searchMapTracks(tracks, query, 6)),
        [mixer.seedId, tracks, query]
    );

    const pickSeed = (id: string) => {
        mixer.setSeed(id);
        setQuery("");
    };

    return (
        <div className={VIBE_PANEL_CLASS} data-testid="mixer-panel">
            <div className="flex items-center justify-between gap-2 mb-2">
                <h3 className="text-sm font-semibold text-white">
                    Similarity mixer
                </h3>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={mixer.resetWeights}
                        title="Reset all sliders to the defaults"
                        className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/10"
                    >
                        <RotateCcw className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close mixer"
                        className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/10"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Seed picker */}
            {mixer.seedTrack ? (
                <div className="flex items-center gap-2 mb-3 rounded-lg bg-white/5 px-2 py-1.5">
                    <Music2 className="w-4 h-4 shrink-0 text-indigo-300" />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm text-white truncate">
                            {mixer.seedTrack.title}
                        </p>
                        <p className="text-xs text-gray-400 truncate">
                            {mixer.seedTrack.artist}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => mixer.setSeed(null)}
                        className="text-xs text-gray-400 hover:text-white shrink-0"
                    >
                        Change
                    </button>
                </div>
            ) : (
                <div className="mb-3">
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Pick a seed track…"
                        className="w-full rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
                    />
                    {matches.length > 0 && (
                        <ul className="mt-1 rounded-lg bg-black/40 border border-white/10 divide-y divide-white/5 max-h-44 overflow-y-auto">
                            {matches.map((t) => (
                                <li key={t.id}>
                                    <button
                                        type="button"
                                        onClick={() => pickSeed(t.id)}
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
                    {nowPlayingId && (
                        <button
                            type="button"
                            onClick={() => pickSeed(nowPlayingId)}
                            className="mt-1.5 w-full rounded-lg bg-indigo-500/20 text-indigo-200 text-sm py-1.5 hover:bg-indigo-500/30"
                        >
                            Use now playing
                        </button>
                    )}
                </div>
            )}

            {mixer.componentsLoading && (
                <p className="flex items-center gap-2 text-xs text-gray-400 mb-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading
                    similarity data…
                </p>
            )}
            {mixer.componentsError && (
                <p className="text-xs text-amber-300/90 mb-2">
                    {mixer.componentsError}
                </p>
            )}

            <div className="overflow-y-auto min-h-0 flex-1 pr-1 space-y-3">
                {/* Audio group */}
                <div className="space-y-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">
                        Audio
                    </p>
                    {AUDIO_GROUP.map((key) => (
                        <WeightSlider
                            key={key}
                            componentKey={key}
                            value={mixer.weights[key]}
                            onChange={mixer.setWeight}
                        />
                    ))}
                </div>

                {/* Lyric group */}
                <div className="space-y-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">
                        Lyrics
                        <span className="ml-1.5 normal-case tracking-normal text-gray-500">
                            — analyzed for {mixer.lyricCoverage.analyzed} of{" "}
                            {mixer.lyricCoverage.total} songs
                        </span>
                    </p>
                    {LYRIC_GROUP.map((key) => (
                        <WeightSlider
                            key={key}
                            componentKey={key}
                            value={mixer.weights[key]}
                            onChange={mixer.setWeight}
                        />
                    ))}
                </div>

                {/* Force controls */}
                <div className="space-y-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">
                        Force
                    </p>
                    <div
                        role="radiogroup"
                        aria-label="Force mode"
                        className="grid grid-cols-3 gap-1"
                    >
                        {(["off", "attract", "repel"] as const).map((mode) => (
                            <button
                                key={mode}
                                type="button"
                                role="radio"
                                aria-checked={mixer.forceMode === mode}
                                disabled={mode !== "off" && !mixer.scores}
                                onClick={() => mixer.setForceMode(mode)}
                                className={
                                    "rounded-md py-1 text-xs capitalize border " +
                                    (mixer.forceMode === mode
                                        ? "bg-indigo-500/30 border-indigo-400/50 text-indigo-100"
                                        : "bg-white/5 border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30")
                                }
                            >
                                {mode}
                            </button>
                        ))}
                    </div>
                    <label
                        className="block"
                        title="How strongly dots drift toward or away from the seed"
                    >
                        <span className="flex items-center justify-between text-xs text-gray-300">
                            <span>Strength</span>
                            <span className="tabular-nums text-gray-400">
                                {Math.round(mixer.forceStrength * 100)}
                            </span>
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={mixer.forceStrength}
                            disabled={mixer.forceMode === "off"}
                            aria-label="Force strength"
                            onChange={(e) =>
                                mixer.setForceStrength(Number(e.target.value))
                            }
                            className="w-full accent-indigo-400 h-1.5 disabled:opacity-30"
                        />
                    </label>
                </div>

                {/* Ranked matches */}
                {mixer.topTracks.length > 0 && (
                    <div>
                        <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                            Closest under this mix
                        </p>
                        <ul className="divide-y divide-white/5">
                            {mixer.topTracks.map(({ track, score }) => (
                                <li key={track.id}>
                                    <button
                                        type="button"
                                        onClick={() => onLocate(track.id)}
                                        title="Fly to this track on the map"
                                        className="w-full flex items-center gap-2 px-1 py-1.5 text-left hover:bg-white/5 rounded-md"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <span className="block text-sm text-white truncate">
                                                {track.title}
                                            </span>
                                            <span className="block text-xs text-gray-400 truncate">
                                                {track.artist}
                                            </span>
                                        </div>
                                        <span className="shrink-0 text-xs tabular-nums text-amber-300">
                                            {Math.round(score * 100)}%
                                        </span>
                                        <LocateFixed className="w-3.5 h-3.5 shrink-0 text-gray-500" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </div>
    );
}
