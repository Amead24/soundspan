/**
 * Turns an XrayResponse into plain-English verdict lines. Pure and
 * data-driven: this module picks WHICH lines apply and with which numbers
 * (thresholds from the v2 plan §verdicts); the actual sentences live in
 * vibeCopy.VERDICT_TEMPLATES so copy edits never touch logic.
 */

import { camelotOf, keyRelation } from "./simMath";
import type { XrayResponse } from "./types";
import { DIMENSION_COPY } from "./vibeCopy";

export interface VerdictLine {
    /** Key into VERDICT_TEMPLATES. */
    key: string;
    /** Values for the template's {placeholders}. */
    values: Record<string, string | number>;
}

const SONIC_TIERS: Array<[number, string]> = [
    [0.85, "sonic-identical"],
    [0.7, "sonic-alike"],
    [0.5, "sonic-loose"],
];

/** Audio features eligible for "…but X differs" callouts (0..1 scales). */
const GAP_FEATURES = new Set([
    "energy",
    "valence",
    "danceability",
    "acousticness",
] as const);
const GAP_THRESHOLD = 0.35;
const TEMPO_GAP_BPM = 15;
const LYRIC_THEME_THRESHOLD = 0.75;
const SENTIMENT_GAP_THRESHOLD = 0.8;

export function buildVerdict(xray: XrayResponse): VerdictLine[] {
    const lines: VerdictLine[] = [];

    // 1. Sonic tier
    if (!xray.clap.available || xray.clap.similarity == null) {
        lines.push({ key: "sonic-unknown", values: {} });
    } else {
        const sim = xray.clap.similarity;
        const tier = SONIC_TIERS.find(([threshold]) => sim >= threshold);
        lines.push({
            key: tier ? tier[1] : "sonic-different",
            values: { percent: Math.round(sim * 100) },
        });
    }

    // 2. Top-2 diverging features — the "energetic next to calm" explainer
    const gaps = xray.features
        .filter(
            (f): f is typeof f & { a: number; b: number } =>
                GAP_FEATURES.has(f.key as never) && f.a != null && f.b != null
        )
        .map((f) => ({ key: f.key, gap: Math.abs(f.a - f.b) }))
        .filter((f) => f.gap >= GAP_THRESHOLD)
        .sort((x, y) => y.gap - x.gap)
        .slice(0, 2);
    for (const { key, gap } of gaps) {
        lines.push({
            key: "gap-callout",
            values: {
                dimension: DIMENSION_COPY[key].label.toLowerCase(),
                percent: Math.round(gap * 100),
            },
        });
    }

    // 3. Tempo gap (raw BPM, not the octave-folded similarity)
    const bpm = xray.features.find((f) => f.key === "bpm");
    if (bpm?.a != null && bpm.b != null) {
        const diff = Math.round(Math.abs(bpm.a - bpm.b));
        if (diff >= TEMPO_GAP_BPM) {
            lines.push({ key: "tempo-apart", values: { bpm: diff } });
        }
    }

    // 4. Key relation (only when both sides map onto the Camelot wheel)
    const relation = keyRelation(
        xray.keys.a?.key,
        xray.keys.a?.scale,
        xray.keys.b?.key,
        xray.keys.b?.scale
    );
    if (relation !== "unknown") {
        const labelA = camelotOf(xray.keys.a?.key, xray.keys.a?.scale)?.label ?? "?";
        const labelB = camelotOf(xray.keys.b?.key, xray.keys.b?.scale)?.label ?? "?";
        lines.push({
            key: `key-${relation}`,
            values: { label: labelA, labelA, labelB },
        });
    }

    // 5. Lyrics
    if (xray.lyrics.aStatus !== "analyzed" || xray.lyrics.bStatus !== "analyzed") {
        lines.push({ key: "lyrics-not-applicable", values: {} });
    } else {
        if (
            xray.lyrics.semanticSimilarity != null &&
            xray.lyrics.semanticSimilarity >= LYRIC_THEME_THRESHOLD
        ) {
            lines.push({
                key: "lyrics-similar-themes",
                values: {
                    percent: Math.round(xray.lyrics.semanticSimilarity * 100),
                },
            });
        }
        if (
            xray.lyrics.sentiment &&
            Math.abs(xray.lyrics.sentiment.a - xray.lyrics.sentiment.b) >=
                SENTIMENT_GAP_THRESHOLD
        ) {
            lines.push({ key: "lyrics-opposite-polarity", values: {} });
        }
    }

    return lines;
}

/** Fill a template's {placeholders} from a VerdictLine. */
export function formatVerdict(
    line: VerdictLine,
    templates: Record<string, string>
): string {
    const template = templates[line.key] ?? line.key;
    return template.replace(/\{(\w+)\}/g, (_, name: string) =>
        String(line.values[name] ?? `{${name}}`)
    );
}
