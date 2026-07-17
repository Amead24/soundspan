"use client";

/**
 * useMixer — state for the weight-mixer lens: seed pick, per-user weights
 * (loaded once, debounced PUT on change), seed similarity components from
 * GET /api/vibe/mixer/:seedId, blended per-track scores (double-buffered
 * Float32Arrays — slider drags never allocate), and the attract/repel force
 * controls. Pure state; VibeMap owns rendering and the position morphs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ForceMode } from "./mapForce";
import type { MapTrack } from "./types";
import {
    computeScores,
    DEFAULT_WEIGHTS,
    packTrackScalars,
    toFloat32,
    topNIndices,
    type MixerComponent,
    type MixerWeights,
} from "./vibeMixer";

const SAVE_DEBOUNCE_MS = 800;
const TOP_N = 20;

export type MixerForceMode = ForceMode | "off";

export interface MixerRankedTrack {
    track: MapTrack;
    index: number;
    score: number;
}

export interface MixerState {
    seedId: string | null;
    seedIndex: number | null;
    seedTrack: MapTrack | null;
    setSeed: (id: string | null) => void;
    weights: MixerWeights;
    setWeight: (key: MixerComponent, value: number) => void;
    resetWeights: () => void;
    /** null until a seed's components have loaded. */
    scores: Float32Array | null;
    topTracks: MixerRankedTrack[];
    componentsLoading: boolean;
    componentsError: string | null;
    lyricCoverage: { analyzed: number; total: number };
    forceMode: MixerForceMode;
    setForceMode: (mode: MixerForceMode) => void;
    forceStrength: number;
    setForceStrength: (value: number) => void;
}

export function useMixer(options: {
    tracks: MapTrack[];
    /** computedAt of the loaded map payload — staleness contract with the
     * mixer endpoint (mismatch = discard components). */
    computedAt: string | null;
    /** True while the mixer surface is open; weights load lazily on first
     * activation. */
    active: boolean;
}): MixerState {
    const { tracks, computedAt, active } = options;

    const [seedId, setSeedId] = useState<string | null>(null);
    const [weights, setWeights] = useState<MixerWeights>({ ...DEFAULT_WEIGHTS });
    const [componentsLoading, setComponentsLoading] = useState(false);
    const [componentsError, setComponentsError] = useState<string | null>(null);
    const [components, setComponents] = useState<{
        seedId: string;
        clapSim: Float32Array;
        lyricSim: Float32Array;
    } | null>(null);
    const [forceMode, setForceMode] = useState<MixerForceMode>("off");
    const [forceStrength, setForceStrength] = useState(0.7);

    const packed = useMemo(() => packTrackScalars(tracks), [tracks]);

    const indexById = useMemo(() => {
        const m = new Map<string, number>();
        for (let i = 0; i < tracks.length; i++) m.set(tracks[i].id, i);
        return m;
    }, [tracks]);

    const seedIndex = seedId != null ? (indexById.get(seedId) ?? null) : null;
    const seedTrack = seedIndex != null ? tracks[seedIndex] : null;

    const lyricCoverage = useMemo(() => {
        let analyzed = 0;
        for (let i = 0; i < packed.hasLyrics.length; i++) {
            analyzed += packed.hasLyrics[i];
        }
        return { analyzed, total: tracks.length };
    }, [packed, tracks.length]);

    // --- Weights: lazy load once, debounced save -----------------------------
    const weightsLoadedRef = useRef(false);
    useEffect(() => {
        if (!active || weightsLoadedRef.current) return;
        weightsLoadedRef.current = true;
        let cancelled = false;
        api.getSimilarityWeights()
            .then((data) => {
                if (!cancelled) setWeights(data.weights as MixerWeights);
            })
            .catch(() => {
                /* defaults already in place; saving later still works */
            });
        return () => {
            cancelled = true;
        };
    }, [active]);

    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scheduleSave = useCallback((next: MixerWeights | null) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            void api.saveSimilarityWeights(next).catch(() => {
                /* local state stays authoritative; next change retries */
            });
        }, SAVE_DEBOUNCE_MS);
    }, []);
    useEffect(() => {
        return () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        };
    }, []);

    const setWeight = useCallback(
        (key: MixerComponent, value: number) => {
            setWeights((cur) => {
                const next = { ...cur, [key]: Math.min(1, Math.max(0, value)) };
                scheduleSave(next);
                return next;
            });
        },
        [scheduleSave]
    );

    const resetWeights = useCallback(() => {
        setWeights({ ...DEFAULT_WEIGHTS });
        scheduleSave(null); // null = clear the stored mix server-side
    }, [scheduleSave]);

    // --- Seed components ------------------------------------------------------
    useEffect(() => {
        if (!seedId) {
            setComponents(null);
            setComponentsError(null);
            return;
        }
        let cancelled = false;
        setComponentsLoading(true);
        setComponentsError(null);
        api.getVibeMixerComponents(seedId)
            .then((data) => {
                if (cancelled) return;
                // Staleness contract: components must be aligned to OUR map
                // payload, or blending would color the wrong dots.
                if (
                    (computedAt && data.computedAt !== computedAt) ||
                    data.count !== tracks.length
                ) {
                    setComponents(null);
                    setComponentsError(
                        "Map data is out of date — reload the page to re-sync"
                    );
                    return;
                }
                setComponents({
                    seedId: data.seedId,
                    clapSim: toFloat32(data.clapSim),
                    lyricSim: toFloat32(data.lyricSim),
                });
            })
            .catch(() => {
                if (!cancelled) {
                    setComponents(null);
                    setComponentsError(
                        "Couldn't load similarity data for that track"
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setComponentsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [seedId, computedAt, tracks.length]);

    const setSeed = useCallback((id: string | null) => {
        setSeedId(id);
    }, []);

    // --- Scores: double-buffered, recomputed synchronously on any input ------
    const scoreBuffersRef = useRef<[Float32Array, Float32Array]>([
        new Float32Array(0),
        new Float32Array(0),
    ]);
    const scoreFlipRef = useRef(0);
    const scoresRef = useRef<Float32Array | null>(null);

    const scores = useMemo(() => {
        if (
            !components ||
            seedIndex == null ||
            components.seedId !== seedId ||
            components.clapSim.length !== tracks.length
        ) {
            scoresRef.current = null;
            return null;
        }
        if (scoreBuffersRef.current[0].length !== tracks.length) {
            scoreBuffersRef.current = [
                new Float32Array(tracks.length),
                new Float32Array(tracks.length),
            ];
        }
        const out = scoreBuffersRef.current[scoreFlipRef.current % 2];
        scoreFlipRef.current += 1;
        computeScores(
            packed,
            seedIndex,
            components.clapSim,
            components.lyricSim,
            weights,
            out
        );
        scoresRef.current = out;
        return out;
    }, [components, seedIndex, seedId, tracks.length, packed, weights]);

    const topTracks = useMemo<MixerRankedTrack[]>(() => {
        if (!scores || seedIndex == null) return [];
        return topNIndices(scores, TOP_N, seedIndex).map((index) => ({
            track: tracks[index],
            index,
            score: scores[index],
        }));
    }, [scores, seedIndex, tracks]);

    return {
        seedId,
        seedIndex,
        seedTrack,
        setSeed,
        weights,
        setWeight,
        resetWeights,
        scores,
        topTracks,
        componentsLoading,
        componentsError,
        lyricCoverage,
        forceMode,
        setForceMode,
        forceStrength,
        setForceStrength,
    };
}
