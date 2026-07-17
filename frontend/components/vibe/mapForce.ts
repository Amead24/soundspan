/**
 * Attract/repel force displacement for the weight mixer: with a seed
 * selected, similar dots drift toward it (attract) or dissimilar dots drift
 * away (repel). Pure, O(n), allocation-free (writes into `out`); the caller
 * feeds the result through the existing positions-lerp morph so the map
 * animates between layouts.
 */

export type ForceMode = "attract" | "repel";

/** Golden angle (radians) — deterministic direction for dots that sit
 * exactly on the seed, so repel doesn't divide by zero or pick a random
 * direction that changes every recompute. */
const GOLDEN_ANGLE = 2.399963229728653;

const ATTRACT_MAX = 0.85; // never fully collapse dots onto the seed
const REPEL_MAX = 0.35; // world units (map is 0..1)

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Compute displaced positions from a base layout.
 *
 * - `base`: interleaved [x0, y0, x1, y1, ...] world coords (0..1)
 * - `scores`: per-track blended similarity to the seed (NaN = unknown)
 * - attract: p = strength · 0.85 · s² (γ=2 emphasizes top matches)
 * - repel:   q = strength · (1−s)², pushed along the seed→dot direction
 * - the seed itself and NaN-scored dots never move
 *
 * `strength` ∈ [0,1]. Returns `out` for chaining.
 */
export function computeForcePositions(
    base: Float32Array,
    seedIndex: number,
    scores: Float32Array,
    mode: ForceMode,
    strength: number,
    out: Float32Array
): Float32Array {
    const seedX = base[seedIndex * 2];
    const seedY = base[seedIndex * 2 + 1];
    const s = clamp01(strength);
    const n = scores.length;

    for (let i = 0; i < n; i++) {
        const xi = i * 2;
        const yi = xi + 1;
        const x = base[xi];
        const y = base[yi];
        const score = scores[i];

        if (i === seedIndex || Number.isNaN(score) || s === 0) {
            out[xi] = x;
            out[yi] = y;
            continue;
        }

        if (mode === "attract") {
            const p = s * ATTRACT_MAX * score * score;
            out[xi] = x + (seedX - x) * p;
            out[yi] = y + (seedY - y) * p;
        } else {
            const q = s * (1 - score) * (1 - score) * REPEL_MAX;
            let dx = x - seedX;
            let dy = y - seedY;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1e-4) {
                // Degenerate overlap: deterministic golden-angle direction
                const angle = i * GOLDEN_ANGLE;
                dx = Math.cos(angle);
                dy = Math.sin(angle);
            } else {
                dx /= len;
                dy /= len;
            }
            out[xi] = clamp01(x + dx * q);
            out[yi] = clamp01(y + dy * q);
        }
    }

    return out;
}
