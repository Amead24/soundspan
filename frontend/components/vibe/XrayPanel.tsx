"use client";

/**
 * XrayPanel — pick two songs, get the component-by-component answer to "why
 * do these (not) match": overall blend, true CLAP similarity, per-feature
 * gap bars, Camelot key badges, the lyric block, shared neighbors, and
 * plain-English verdicts (verdict.ts thresholds + vibeCopy templates).
 *
 * A/B picking is in-panel search + "now playing"/"mixer seed" shortcuts —
 * deliberately NO new dot-click semantics (useVibeMode is untouched).
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Loader2, Music2 } from "lucide-react";
import { api } from "@/lib/api";
import {
    DIMENSION_META,
    MIXER_COMPONENTS,
    XRAY_GAP_BAR_KEYS,
    type MixerComponent,
} from "./dimensions";
import { VibePanel } from "./panelChrome";
import { camelotOf } from "./simMath";
import { TrackSearchPicker, type TrackSearchShortcut } from "./TrackSearchPicker";
import type { MapTrack, XrayResponse } from "./types";
import { buildVerdict, formatVerdict } from "./verdict";
import { DIMENSION_COPY, VERDICT_TEMPLATES } from "./vibeCopy";

export interface XrayPanelProps {
    tracks: MapTrack[];
    /** Now-playing track id when present on the map, else null. */
    nowPlayingId: string | null;
    /** The mixer's current seed, offered as a pick shortcut. */
    mixerSeedId: string | null;
    onLocate: (id: string) => void;
    onClose: () => void;
}

function TrackPicker({
    label,
    picked,
    tracks,
    nowPlayingId,
    mixerSeedId,
    onPick,
}: {
    label: string;
    picked: MapTrack | null;
    tracks: MapTrack[];
    nowPlayingId: string | null;
    mixerSeedId: string | null;
    onPick: (id: string | null) => void;
}) {
    if (picked) {
        return (
            <div className="flex items-center gap-2 rounded-lg bg-white/5 px-2 py-1.5">
                <span className="shrink-0 w-5 h-5 grid place-items-center rounded-full bg-indigo-500/30 text-[11px] text-indigo-200">
                    {label}
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate">{picked.title}</p>
                    <p className="text-xs text-gray-400 truncate">
                        {picked.artist}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => onPick(null)}
                    className="text-xs text-gray-400 hover:text-white shrink-0"
                >
                    Change
                </button>
            </div>
        );
    }

    const shortcuts: TrackSearchShortcut[] = [
        ...(nowPlayingId ? [{ id: nowPlayingId, label: "Now playing" }] : []),
        ...(mixerSeedId
            ? [{ id: mixerSeedId, label: "Mixer seed", tone: "amber" as const }]
            : []),
    ];

    return (
        <TrackSearchPicker
            tracks={tracks}
            limit={5}
            placeholder={`Song ${label}…`}
            ariaLabel={`Pick song ${label}`}
            shortcuts={shortcuts}
            onPick={onPick}
        />
    );
}

/** Dual-marker gap bar: A and B positions on a 0..1 axis, plain divs. */
function GapBar({ a, b }: { a: number | null; b: number | null }) {
    if (a == null || b == null) {
        return <span className="text-[11px] text-gray-500">no data</span>;
    }
    return (
        <div className="relative h-1.5 rounded-full bg-white/10">
            <span
                className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-indigo-300"
                style={{ left: `calc(${Math.min(1, Math.max(0, a)) * 100}% - 4px)` }}
                title={`A: ${a.toFixed(2)}`}
            />
            <span
                className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-amber-300"
                style={{ left: `calc(${Math.min(1, Math.max(0, b)) * 100}% - 4px)` }}
                title={`B: ${b.toFixed(2)}`}
            />
        </div>
    );
}

// Row kinds + labels derive from the dimension registry: a new dimension
// registered with xray: "gap-bar" renders here with zero panel edits.
const FEATURE_LABEL: Record<string, string> = Object.fromEntries(
    MIXER_COMPONENTS.map((k) => [k, DIMENSION_COPY[k].label])
);
const XRAY_BPM_KEY = MIXER_COMPONENTS.find(
    (k) => DIMENSION_META[k].xray === "bpm"
);

export function XrayPanel({
    tracks,
    nowPlayingId,
    mixerSeedId,
    onLocate,
    onClose,
}: XrayPanelProps) {
    const [aId, setAId] = useState<string | null>(null);
    const [bId, setBId] = useState<string | null>(null);
    const [xray, setXray] = useState<XrayResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const byId = useMemo(() => {
        const m = new Map<string, MapTrack>();
        for (const t of tracks) m.set(t.id, t);
        return m;
    }, [tracks]);

    useEffect(() => {
        if (!aId || !bId || aId === bId) {
            setXray(null);
            setError(aId && bId && aId === bId ? "Pick two different songs" : null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        api.getVibeXray(aId, bId)
            .then((data) => {
                if (!cancelled) setXray(data as XrayResponse);
            })
            .catch(() => {
                if (!cancelled) setError("Couldn't compare those two tracks");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [aId, bId]);

    const verdicts = useMemo(() => (xray ? buildVerdict(xray) : []), [xray]);
    const camelotA = xray?.keys.a ? camelotOf(xray.keys.a.key, xray.keys.a.scale) : null;
    const camelotB = xray?.keys.b ? camelotOf(xray.keys.b.key, xray.keys.b.scale) : null;

    return (
        <VibePanel
            title="Song x-ray"
            icon={<ArrowLeftRight className="w-4 h-4 text-indigo-300" />}
            onClose={onClose}
            closeLabel="Close x-ray"
            testId="xray-panel"
        >
            <div className="space-y-2 mb-3">
                <TrackPicker
                    label="A"
                    picked={aId ? (byId.get(aId) ?? null) : null}
                    tracks={tracks}
                    nowPlayingId={nowPlayingId}
                    mixerSeedId={mixerSeedId}
                    onPick={setAId}
                />
                <TrackPicker
                    label="B"
                    picked={bId ? (byId.get(bId) ?? null) : null}
                    tracks={tracks}
                    nowPlayingId={nowPlayingId}
                    mixerSeedId={mixerSeedId}
                    onPick={setBId}
                />
            </div>

            {loading && (
                <p className="flex items-center gap-2 text-xs text-gray-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Comparing…
                </p>
            )}
            {error && <p className="text-xs text-amber-300/90">{error}</p>}

            {xray && !loading && (
                <div className="overflow-y-auto min-h-0 flex-1 pr-1 space-y-3">
                    {/* Overall */}
                    <div className="rounded-lg bg-white/5 px-3 py-2 text-center">
                        <p className="text-2xl font-semibold text-white tabular-nums">
                            {Math.round(xray.overall.similarity * 100)}%
                        </p>
                        <p className="text-[11px] text-gray-400">
                            overall match under your{" "}
                            {xray.overall.weights === "custom"
                                ? "custom mix"
                                : "default mix"}
                            {xray.clap.similarity != null &&
                                ` · ${Math.round(xray.clap.similarity * 100)}% sonic`}
                        </p>
                    </div>

                    {/* Verdicts */}
                    {verdicts.length > 0 && (
                        <ul className="space-y-1">
                            {verdicts.map((line, i) => (
                                <li
                                    key={`${line.key}-${i}`}
                                    className="text-xs text-gray-200 leading-relaxed"
                                >
                                    {formatVerdict(line, VERDICT_TEMPLATES)}
                                </li>
                            ))}
                        </ul>
                    )}

                    {/* Feature gap bars */}
                    <div>
                        <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">
                            Audio features{" "}
                            <span className="normal-case tracking-normal">
                                (<span className="text-indigo-300">A</span> ·{" "}
                                <span className="text-amber-300">B</span>)
                            </span>
                        </p>
                        <div className="space-y-2">
                            {xray.features
                                .filter((f) =>
                                    XRAY_GAP_BAR_KEYS.has(f.key as MixerComponent)
                                )
                                .map((f) => (
                                    <div key={f.key}>
                                        <span className="flex items-center justify-between text-xs text-gray-300 mb-0.5">
                                            <span>{FEATURE_LABEL[f.key]}</span>
                                            <span className="tabular-nums text-gray-500">
                                                {Math.round(f.similarity * 100)}%
                                            </span>
                                        </span>
                                        <GapBar a={f.a} b={f.b} />
                                    </div>
                                ))}
                            {(() => {
                                const bpm = xray.features.find(
                                    (f) => f.key === XRAY_BPM_KEY
                                );
                                if (!bpm) return null;
                                return (
                                    <p className="text-xs text-gray-300">
                                        {FEATURE_LABEL.bpm}:{" "}
                                        <span className="text-indigo-300 tabular-nums">
                                            {bpm.a != null ? Math.round(bpm.a) : "?"}
                                        </span>{" "}
                                        ·{" "}
                                        <span className="text-amber-300 tabular-nums">
                                            {bpm.b != null ? Math.round(bpm.b) : "?"}
                                        </span>{" "}
                                        BPM
                                        <span className="float-right tabular-nums text-gray-500">
                                            {Math.round(bpm.similarity * 100)}%
                                        </span>
                                    </p>
                                );
                            })()}
                        </div>
                    </div>

                    {/* Keys */}
                    <p className="text-xs text-gray-300">
                        Key:{" "}
                        <span className="inline-block rounded bg-indigo-500/20 text-indigo-200 px-1.5 py-0.5 tabular-nums">
                            {camelotA?.label ??
                                (xray.keys.a
                                    ? `${xray.keys.a.key} ${xray.keys.a.scale ?? ""}`.trim()
                                    : "?")}
                        </span>{" "}
                        <span className="inline-block rounded bg-amber-500/20 text-amber-200 px-1.5 py-0.5 tabular-nums">
                            {camelotB?.label ??
                                (xray.keys.b
                                    ? `${xray.keys.b.key} ${xray.keys.b.scale ?? ""}`.trim()
                                    : "?")}
                        </span>
                    </p>

                    {/* Lyrics */}
                    <div>
                        <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                            Lyrics
                        </p>
                        {xray.lyrics.aStatus === "analyzed" &&
                        xray.lyrics.bStatus === "analyzed" ? (
                            <div className="space-y-1 text-xs text-gray-300">
                                {xray.lyrics.semanticSimilarity != null && (
                                    <p>
                                        Themes match{" "}
                                        <span className="tabular-nums text-white">
                                            {Math.round(
                                                xray.lyrics.semanticSimilarity * 100
                                            )}
                                            %
                                        </span>
                                    </p>
                                )}
                                {xray.lyrics.sentiment && (
                                    <p>
                                        Mood of the words:{" "}
                                        <span className="text-indigo-300 tabular-nums">
                                            {xray.lyrics.sentiment.a.toFixed(2)}
                                        </span>{" "}
                                        ·{" "}
                                        <span className="text-amber-300 tabular-nums">
                                            {xray.lyrics.sentiment.b.toFixed(2)}
                                        </span>{" "}
                                        <span className="text-gray-500">
                                            (−1 bleak … +1 euphoric)
                                        </span>
                                    </p>
                                )}
                                {xray.lyrics.lexical && (
                                    <p>
                                        Vocabulary:{" "}
                                        <span className="text-indigo-300 tabular-nums">
                                            {Math.round(xray.lyrics.lexical.a)}
                                        </span>{" "}
                                        ·{" "}
                                        <span className="text-amber-300 tabular-nums">
                                            {Math.round(xray.lyrics.lexical.b)}
                                        </span>{" "}
                                        <span className="text-gray-500">MTLD</span>
                                    </p>
                                )}
                            </div>
                        ) : (
                            <p className="text-xs text-gray-500">
                                {formatVerdict(
                                    { key: "lyrics-not-applicable", values: {} },
                                    VERDICT_TEMPLATES
                                )}
                            </p>
                        )}
                    </div>

                    {/* Shared neighbors */}
                    {xray.sharedNeighbors.length > 0 && (
                        <div>
                            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Both are close to
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {xray.sharedNeighbors.map((n) => (
                                    <button
                                        key={n.id}
                                        type="button"
                                        onClick={() => onLocate(n.id)}
                                        title={`${n.title} — ${n.artist} (fly to it)`}
                                        className="inline-flex items-center gap-1 rounded-full bg-white/5 border border-white/10 px-2 py-1 text-xs text-gray-200 hover:bg-white/10 max-w-full"
                                    >
                                        <Music2 className="w-3 h-3 shrink-0 text-gray-500" />
                                        <span className="truncate">
                                            {n.title}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </VibePanel>
    );
}
