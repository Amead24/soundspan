import assert from "node:assert/strict";
import test from "node:test";
import {
    bpmSimilarity,
    camelotOf,
    featureCloseness,
    keyRelation,
    keySimilarity,
    lexicalCloseness,
    readingCloseness,
    sentimentCloseness,
} from "../../components/vibe/simMath";

function approx(actual: number, expected: number, eps = 1e-9): void {
    assert.ok(
        Math.abs(actual - expected) <= eps,
        `expected ${expected}, got ${actual}`
    );
}

// Numeric vectors enumerated from the SQL functions in
// backend/prisma/migrations/20260130000000_add_similarity_functions — these
// pins are the contract that the client mixer and the server agree on what
// "similar" means. Do not change one side without the other.

test("bpmSimilarity: identical tempo is a perfect match", () => {
    approx(bpmSimilarity(120, 120), 1.0);
});

test("bpmSimilarity: half/double time folds into the same octave (perfect)", () => {
    // 60 folds to 120 → direct_diff 0 → 1.0 (folding wins before the
    // half-time branch is ever reached)
    approx(bpmSimilarity(120, 60), 1.0);
});

test("bpmSimilarity: inside the 20 BPM window costs up to 30%", () => {
    approx(bpmSimilarity(120, 130), 1.0 - (10 / 20) * 0.3); // 0.85
    approx(bpmSimilarity(120, 140), 1.0 - (20 / 20) * 0.3); // 0.7
});

test("bpmSimilarity: beyond the window falls off linearly", () => {
    // 100 vs 139: folded diff 39 → 0.6 - (39-20)/60
    approx(bpmSimilarity(100, 139), 0.6 - 19 / 60);
});

test("bpmSimilarity: nulls and non-positive values are neutral 0.5", () => {
    approx(bpmSimilarity(null, 120), 0.5);
    approx(bpmSimilarity(120, undefined), 0.5);
    approx(bpmSimilarity(0, 120), 0.5); // SQL would infinite-loop; we guard
});

test("keySimilarity: same key+scale = 1.0, relative = 0.92", () => {
    approx(keySimilarity("C", "major", "C", "major"), 1.0);
    // C major (8B) vs A minor (8A): same wheel position, other mode
    approx(keySimilarity("C", "major", "A", "minor"), 0.92);
});

test("keySimilarity: adjacent on the wheel = 0.85 same mode / 0.75 cross", () => {
    // C major (8B) vs G major (9B)
    approx(keySimilarity("C", "major", "G", "major"), 0.85);
    // C major (8B) vs E minor (9A)
    approx(keySimilarity("C", "major", "E", "minor"), 0.75);
});

test("keySimilarity: distant keys fall off 0.15 per step (+0.1 cross-mode)", () => {
    // C major (8B) vs F# major (2B): circle dist 6 → 1 - 0.9 = 0.1
    approx(keySimilarity("C", "major", "F#", "major"), 1.0 - 6 * 0.15);
    // C major (8B) vs Bb minor (3A): dist 5 → 1 - 0.75 - 0.1 = 0.15
    approx(keySimilarity("C", "major", "Bb", "minor"), 1.0 - 5 * 0.15 - 0.1);
});

test("keySimilarity: nulls neutral; unknown spellings default to 8B (SQL quirk)", () => {
    approx(keySimilarity(null, null, "C", "major"), 0.5);
    // "H" isn't in the table → treated as 8B → same as C major → 1.0
    approx(keySimilarity("H", "major", "C", "major"), 1.0);
});

test("camelotOf: labels and honest null for unknown spellings", () => {
    assert.deepEqual(camelotOf("C", "major"), { num: 8, mode: "B", label: "8B" });
    assert.deepEqual(camelotOf("A", "minor"), { num: 8, mode: "A", label: "8A" });
    assert.equal(camelotOf("G#", "minor"), null); // enharmonic not in table
    assert.equal(camelotOf(null, "major"), null);
});

test("keyRelation: same / relative / adjacent / distant / unknown", () => {
    assert.equal(keyRelation("C", "major", "C", "major"), "same");
    assert.equal(keyRelation("C", "major", "A", "minor"), "relative");
    assert.equal(keyRelation("C", "major", "G", "major"), "adjacent");
    assert.equal(keyRelation("C", "major", "F#", "major"), "distant");
    assert.equal(keyRelation("G#", "minor", "C", "major"), "unknown");
});

test("closeness functions match the plan's §core-math definitions", () => {
    approx(featureCloseness(0.8, 0.3), 0.5);
    approx(featureCloseness(null, 0.5), 1.0); // null coalesces to 0.5
    approx(sentimentCloseness(-1, 1), 0);
    approx(sentimentCloseness(0.5, 0.5), 1);
    approx(lexicalCloseness(20, 80), 1 - 60 / 120);
    approx(lexicalCloseness(200, 120), 1); // both clamp to 120
    approx(readingCloseness(2, 8), 1 - 6 / 12);
    approx(readingCloseness(0, 30), 0); // gap clamps at 12
});
