"use client";

/**
 * MixerPanel — the weight-mixer aux surface: pick a seed track (in-panel
 * search or "use now playing" — deliberately NO new dot-click semantics),
 * drag per-dimension sliders to re-blend similarity live (the map recolors
 * via MapCanvas's score props), toggle the attract/repel force, and browse
 * the ranked top matches. All state lives in useMixer; this is presentation.
 */

import { Loader2, LocateFixed, Music2, RotateCcw } from "lucide-react";
import { VibePanel } from "./panelChrome";
import { TrackSearchPicker } from "./TrackSearchPicker";
import type { MixerState } from "./useMixer";
import type { MapTrack } from "./types";
import type { MixerComponent } from "./vibeMixer";
import { DIMENSION_COPY } from "./vibeCopy";

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
    return (
        <VibePanel
            title="Similarity mixer"
            headerExtra={
                <button
                    type="button"
                    onClick={mixer.resetWeights}
                    title="Reset all sliders to the defaults"
                    aria-label="Reset all sliders to the defaults"
                    className="ml-auto inline-flex items-center justify-center w-10 h-10 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                >
                    <RotateCcw className="w-4 h-4" />
                </button>
            }
            onClose={onClose}
            closeLabel="Close mixer"
            testId="mixer-panel"
        >
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
                    <TrackSearchPicker
                        tracks={tracks}
                        limit={6}
                        placeholder="Pick a seed track…"
                        ariaLabel="Pick a seed track"
                        shortcuts={
                            nowPlayingId
                                ? [{ id: nowPlayingId, label: "Use now playing" }]
                                : []
                        }
                        onPick={mixer.setSeed}
                    />
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
        </VibePanel>
    );
}
