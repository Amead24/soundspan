/**
 * TS ports of the backend's similarity primitives, pinned to the SQL
 * functions in backend/prisma/migrations/20260130000000_add_similarity_functions.
 * The unit tests enumerate numeric vectors from that migration — if you
 * change anything here, the server and the client mixer disagree about what
 * "similar" means. Quirks (unknown-key → Camelot 8B, half-time window on RAW
 * bpm) are intentional ports, not bugs.
 */

/** Exact port of SQL bpm_similarity: octave-fold into [70,140], 30%-max
 * penalty inside a 20 BPM window, half/double-time window on raw values,
 * linear falloff beyond. Nulls (and non-positive values, which the SQL
 * version would infinite-loop on) → 0.5 neutral. */
export function bpmSimilarity(bpm1: number | null | undefined, bpm2: number | null | undefined): number {
    if (bpm1 == null || bpm2 == null || bpm1 <= 0 || bpm2 <= 0) return 0.5;

    let norm1 = bpm1;
    while (norm1 < 70) norm1 *= 2;
    while (norm1 > 140) norm1 /= 2;
    let norm2 = bpm2;
    while (norm2 < 70) norm2 *= 2;
    while (norm2 > 140) norm2 /= 2;

    const directDiff = Math.abs(norm1 - norm2);
    if (directDiff <= 20) return 1.0 - (directDiff / 20) * 0.3;

    const halfDiff = Math.min(Math.abs(bpm1 - bpm2 * 2), Math.abs(bpm1 * 2 - bpm2));
    if (halfDiff <= 10) return 0.75 - (halfDiff / 10) * 0.15;

    return Math.max(0, 0.6 - (directDiff - 20) / 60);
}

/** Camelot wheel positions, mirroring the SQL function's JSONB table. */
const CAMELOT: Record<string, readonly [number, "A" | "B"]> = {
    Ab_minor: [1, "A"], Eb_minor: [2, "A"], Bb_minor: [3, "A"],
    F_minor: [4, "A"], C_minor: [5, "A"], G_minor: [6, "A"],
    D_minor: [7, "A"], A_minor: [8, "A"], E_minor: [9, "A"],
    B_minor: [10, "A"], "F#_minor": [11, "A"], Db_minor: [12, "A"],
    B_major: [1, "B"], "F#_major": [2, "B"], Db_major: [3, "B"],
    Ab_major: [4, "B"], Eb_major: [5, "B"], Bb_major: [6, "B"],
    F_major: [7, "B"], C_major: [8, "B"], G_major: [9, "B"],
    D_major: [10, "B"], A_major: [11, "B"], E_major: [12, "B"],
};

export interface CamelotPosition {
    num: number;
    mode: "A" | "B";
    /** e.g. "8A" — the DJ-facing label */
    label: string;
}

/** Camelot position for display. Returns null for unknown/enharmonic
 * spellings the table doesn't carry (the similarity fn defaults those to 8B
 * to match SQL — display should stay honest instead). */
export function camelotOf(
    key: string | null | undefined,
    scale: string | null | undefined
): CamelotPosition | null {
    if (!key) return null;
    const entry = CAMELOT[`${key}_${scale ?? "major"}`];
    if (!entry) return null;
    return { num: entry[0], mode: entry[1], label: `${entry[0]}${entry[1]}` };
}

/** Exact port of SQL key_similarity (incl. the unknown-key → [8,'B'] default). */
export function keySimilarity(
    key1: string | null | undefined,
    scale1: string | null | undefined,
    key2: string | null | undefined,
    scale2: string | null | undefined
): number {
    if (key1 == null || key2 == null) return 0.5;

    const e1 = CAMELOT[`${key1}_${scale1 ?? "major"}`] ?? [8, "B"];
    const e2 = CAMELOT[`${key2}_${scale2 ?? "major"}`] ?? [8, "B"];
    const [pos1, mode1] = e1;
    const [pos2, mode2] = e2;

    const circleDist = Math.min(Math.abs(pos1 - pos2), 12 - Math.abs(pos1 - pos2));

    if (pos1 === pos2 && mode1 === mode2) return 1.0;
    if (pos1 === pos2 && mode1 !== mode2) return 0.92;
    if (circleDist === 1) return mode1 === mode2 ? 0.85 : 0.75;
    return Math.max(0, 1.0 - circleDist * 0.15 - (mode1 !== mode2 ? 0.1 : 0));
}

export type KeyRelation = "same" | "relative" | "adjacent" | "distant" | "unknown";

/** DJ-facing relation between two keys, derived from Camelot positions. */
export function keyRelation(
    key1: string | null | undefined,
    scale1: string | null | undefined,
    key2: string | null | undefined,
    scale2: string | null | undefined
): KeyRelation {
    const a = camelotOf(key1, scale1);
    const b = camelotOf(key2, scale2);
    if (!a || !b) return "unknown";
    if (a.num === b.num && a.mode === b.mode) return "same";
    if (a.num === b.num) return "relative";
    const circleDist = Math.min(Math.abs(a.num - b.num), 12 - Math.abs(a.num - b.num));
    if (circleDist === 1 && a.mode === b.mode) return "adjacent";
    return "distant";
}

// --- Closeness functions (§core-math of the v2 plan; mirror the backend) ---

/** 1 − |a−b| with 0.5-neutral coalescing (matches the SQL COALESCE pattern). */
export function featureCloseness(a: number | null | undefined, b: number | null | undefined): number {
    return 1 - Math.abs((a ?? 0.5) - (b ?? 0.5));
}

/** VADER compound ∈ [−1,1] → closeness. */
export function sentimentCloseness(a: number, b: number): number {
    return 1 - Math.abs(a - b) / 2;
}

/** MTLD, clamped at 120 → closeness. */
export function lexicalCloseness(a: number, b: number): number {
    return 1 - Math.abs(Math.min(a, 120) - Math.min(b, 120)) / 120;
}

/** FK grade, gap clamped at 12 → closeness. */
export function readingCloseness(a: number, b: number): number {
    return 1 - Math.min(Math.abs(a - b), 12) / 12;
}
