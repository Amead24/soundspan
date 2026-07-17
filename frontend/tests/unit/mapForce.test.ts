import assert from "node:assert/strict";
import test from "node:test";
import { computeForcePositions } from "../../components/vibe/mapForce";

function positions(...pairs: Array<[number, number]>): Float32Array {
    return new Float32Array(pairs.flat());
}

test("the seed never moves", () => {
    const base = positions([0.5, 0.5], [0.9, 0.9]);
    const out = new Float32Array(4);
    computeForcePositions(base, 0, new Float32Array([1, 0.8]), "attract", 1, out);
    assert.equal(out[0], 0.5);
    assert.equal(out[1], 0.5);
});

test("attract pulls high-score dots toward the seed, low scores barely move", () => {
    const base = positions([0.5, 0.5], [0.9, 0.5], [0.1, 0.5]);
    const out = new Float32Array(6);
    computeForcePositions(
        base,
        0,
        new Float32Array([1, 0.95, 0.1]),
        "attract",
        1,
        out
    );
    const highMove = Math.abs(out[2] - 0.9);
    const lowMove = Math.abs(out[4] - 0.1);
    assert.ok(highMove > lowMove * 10, `high ${highMove} vs low ${lowMove}`);
    // γ=2, cap 0.85: displacement = 0.85·0.95² of the way to the seed
    const expected = 0.9 + (0.5 - 0.9) * 0.85 * 0.95 * 0.95;
    assert.ok(Math.abs(out[2] - expected) < 1e-6);
});

test("attract never fully collapses a dot onto the seed", () => {
    const base = positions([0.5, 0.5], [0.9, 0.9]);
    const out = new Float32Array(4);
    computeForcePositions(base, 0, new Float32Array([1, 1]), "attract", 1, out);
    assert.notEqual(out[2], 0.5); // 0.85 cap leaves a gap
});

test("repel pushes dissimilar dots away, clamped to the map", () => {
    const base = positions([0.5, 0.5], [0.95, 0.5], [0.6, 0.5]);
    const out = new Float32Array(6);
    computeForcePositions(
        base,
        0,
        new Float32Array([1, 0.05, 0.95]),
        "repel",
        1,
        out
    );
    assert.equal(out[2], 1); // pushed past the edge → clamped to 1
    assert.ok(Math.abs(out[4] - 0.6) < 0.01); // near-identical barely moves
});

test("repel on a dot exactly at the seed picks a deterministic direction", () => {
    const base = positions([0.5, 0.5], [0.5, 0.5]);
    const out1 = new Float32Array(4);
    const out2 = new Float32Array(4);
    computeForcePositions(base, 0, new Float32Array([1, 0]), "repel", 1, out1);
    computeForcePositions(base, 0, new Float32Array([1, 0]), "repel", 1, out2);
    assert.notEqual(out1[2], 0.5); // it moved
    assert.equal(out1[2], out2[2]); // deterministically
    assert.equal(out1[3], out2[3]);
});

test("strength 0 is the identity; NaN scores stay put", () => {
    const base = positions([0.5, 0.5], [0.9, 0.9], [0.2, 0.2]);
    const out = new Float32Array(6);
    computeForcePositions(
        base,
        0,
        new Float32Array([1, NaN, 0.5]),
        "attract",
        0,
        out
    );
    assert.deepEqual(Array.from(out), Array.from(base));

    computeForcePositions(
        base,
        0,
        new Float32Array([1, NaN, 0.5]),
        "attract",
        1,
        out
    );
    assert.equal(out[2], base[2]); // NaN dot untouched even at full strength
    assert.equal(out[3], base[3]);
});
