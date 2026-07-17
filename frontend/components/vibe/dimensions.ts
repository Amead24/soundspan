/**
 * dimensions — THE single frontend home of the similarity-dimension registry
 * (review finding B5). Everything a new dimension needs on the frontend
 * derives from here: the component list + type, the mixer panel's slider
 * groups, packTrackScalars' packed columns, and the x-ray's per-feature row
 * kinds. `DIMENSION_COPY` (vibeCopy.ts) and `DEFAULT_WEIGHTS` (vibeMixer.ts)
 * stay separate but are `Record<MixerComponent, …>`-typed, so a missing
 * entry is a compile error, and the backend contract test
 * (backend/src/__tests__/vibeMixerComponentsContract.test.ts) pins
 * MIXER_COMPONENTS to the backend's SIMILARITY_COMPONENTS value-for-value.
 *
 * Deliberately NOT derived from here: computeScores' blend loop (vibeMixer)
 * and the SQL blends — those are the perf contract, hand-written on purpose;
 * B2's contract test and the x-ray simMath pins guard them instead.
 *
 * No React, no DOM — pure data, unit-importable anywhere.
 */

import type { MapTrack } from "./types";

/** Canonical component list, in backend order (SIMILARITY_COMPONENTS). The
 * backend contract test parses this literal — keep it a plain string array. */
export const MIXER_COMPONENTS = [
    "clap",
    "lyricSemantic",
    "lyricSentiment",
    "lyricLexical",
    "lyricReading",
    "energy",
    "valence",
    "bpm",
    "danceability",
    "acousticness",
    "instrumentalness",
    "key",
] as const;

export type MixerComponent = (typeof MIXER_COMPONENTS)[number];

/** Dimensions whose per-track value packs into a Float32Array column for the
 * mixer's scoring loop (clap/lyricSemantic score via the endpoint's sim
 * arrays; key packs as raw strings for the Camelot quirk). */
export const SCALAR_DIMENSION_KEYS = [
    "lyricSentiment",
    "lyricLexical",
    "lyricReading",
    "energy",
    "valence",
    "bpm",
    "danceability",
    "acousticness",
    "instrumentalness",
] as const;

export type ScalarDimensionKey = (typeof SCALAR_DIMENSION_KEYS)[number];

/** How the x-ray panel renders this dimension's row. */
export type XrayRenderKind = "gap-bar" | "bpm" | "lyric-block" | "none";

type DimensionMetaFor<K extends MixerComponent> = {
    group: "audio" | "lyric";
    xray: XrayRenderKind;
} & (K extends ScalarDimensionKey
    ? {
          /** MapTrack accessor feeding this dimension's packed column. */
          scalar: (t: MapTrack) => number | null | undefined;
      }
    : { scalar?: never });

/** Per-dimension metadata. The mapped type forces: an entry for every
 * component, a scalar accessor for exactly the SCALAR_DIMENSION_KEYS, and
 * none anywhere else — a half-registered 13th dimension cannot compile. */
export const DIMENSION_META: { [K in MixerComponent]: DimensionMetaFor<K> } = {
    clap: { group: "audio", xray: "none" },
    lyricSemantic: { group: "lyric", xray: "lyric-block" },
    lyricSentiment: {
        group: "lyric",
        xray: "lyric-block",
        scalar: (t) => t.sentiment,
    },
    lyricLexical: {
        group: "lyric",
        xray: "lyric-block",
        scalar: (t) => t.lexicalDiversity,
    },
    lyricReading: {
        group: "lyric",
        xray: "lyric-block",
        scalar: (t) => t.readingLevel,
    },
    energy: { group: "audio", xray: "gap-bar", scalar: (t) => t.energy },
    valence: { group: "audio", xray: "gap-bar", scalar: (t) => t.valence },
    bpm: { group: "audio", xray: "bpm", scalar: (t) => t.bpm },
    danceability: {
        group: "audio",
        xray: "gap-bar",
        scalar: (t) => t.danceability,
    },
    acousticness: {
        group: "audio",
        xray: "gap-bar",
        scalar: (t) => t.acousticness,
    },
    instrumentalness: {
        group: "audio",
        xray: "gap-bar",
        scalar: (t) => t.instrumentalness,
    },
    key: { group: "audio", xray: "none" },
};

/** Mixer-panel slider groups, in canonical order. */
export const AUDIO_DIMENSION_KEYS: readonly MixerComponent[] =
    MIXER_COMPONENTS.filter((k) => DIMENSION_META[k].group === "audio");
export const LYRIC_DIMENSION_KEYS: readonly MixerComponent[] =
    MIXER_COMPONENTS.filter((k) => DIMENSION_META[k].group === "lyric");

/** Keys the x-ray renders as dual-marker gap bars, in canonical order. */
export const XRAY_GAP_BAR_KEYS: ReadonlySet<string> = new Set(
    MIXER_COMPONENTS.filter((k) => DIMENSION_META[k].xray === "gap-bar")
);
