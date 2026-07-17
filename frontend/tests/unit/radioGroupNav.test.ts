import assert from "node:assert/strict";
import test from "node:test";
import {
    radioTargetFor,
    rovingTabIndex,
} from "../../components/vibe/radioGroupNav";

const MODES = ["off", "attract", "repel"] as const;

test("arrows move selection forward/backward with wrapping", () => {
    assert.equal(radioTargetFor("ArrowRight", MODES, "off"), "attract");
    assert.equal(radioTargetFor("ArrowDown", MODES, "off"), "attract");
    assert.equal(radioTargetFor("ArrowRight", MODES, "repel"), "off"); // wraps
    assert.equal(radioTargetFor("ArrowLeft", MODES, "off"), "repel"); // wraps
    assert.equal(radioTargetFor("ArrowUp", MODES, "attract"), "off");
});

test("Home and End jump to the first/last enabled option", () => {
    assert.equal(radioTargetFor("Home", MODES, "repel"), "off");
    assert.equal(radioTargetFor("End", MODES, "off"), "repel");
    const disabled = (m: string) => m === "repel";
    assert.equal(radioTargetFor("End", MODES, "off", disabled), "attract");
});

test("disabled options are skipped in both directions", () => {
    const disabled = (m: string) => m === "attract";
    assert.equal(radioTargetFor("ArrowRight", MODES, "off", disabled), "repel");
    assert.equal(radioTargetFor("ArrowLeft", MODES, "repel", disabled), "off");
});

test("returns null when every other option is disabled (nowhere to go)", () => {
    const disabled = (m: string) => m !== "off";
    assert.equal(radioTargetFor("ArrowRight", MODES, "off", disabled), null);
    assert.equal(radioTargetFor("ArrowLeft", MODES, "off", disabled), null);
});

test("non-navigation keys are left alone (Tab must exit the group)", () => {
    assert.equal(radioTargetFor("Tab", MODES, "off"), null);
    assert.equal(radioTargetFor("Enter", MODES, "off"), null);
    assert.equal(radioTargetFor("a", MODES, "off"), null);
});

test("empty option lists never navigate", () => {
    assert.equal(radioTargetFor("ArrowRight", [], "off"), null);
});

test("rovingTabIndex makes exactly the checked option the Tab stop", () => {
    assert.equal(rovingTabIndex("off", "off"), 0);
    assert.equal(rovingTabIndex("attract", "off"), -1);
});
