import assert from "node:assert/strict";
import test from "node:test";
import {
    SIDEBAR_NAVIGATION,
    MOBILE_QUICK_LINKS,
} from "../../components/layout/socialNavigation";

test("sidebar navigation has 8 items", () => {
    assert.equal(SIDEBAR_NAVIGATION.length, 8);
});

test("sidebar navigation starts with Home then Explore", () => {
    assert.equal(SIDEBAR_NAVIGATION[0].name, "Home");
    assert.equal(SIDEBAR_NAVIGATION[0].href, "/");
    assert.equal(SIDEBAR_NAVIGATION[1].name, "Explore");
    assert.equal(SIDEBAR_NAVIGATION[1].href, "/explore");
});

test("sidebar navigation exposes both vibe destinations after Explore", () => {
    assert.equal(SIDEBAR_NAVIGATION[2].name, "Vibe Explore");
    assert.equal(SIDEBAR_NAVIGATION[2].href, "/vibe");
    assert.equal(SIDEBAR_NAVIGATION[3].name, "Vibe Map");
    assert.equal(SIDEBAR_NAVIGATION[3].href, "/vibe?tab=map");
});

test("sidebar navigation includes Library, Listen Together, Audiobooks, Podcasts", () => {
    const names = SIDEBAR_NAVIGATION.map((item) => item.name);
    assert.ok(names.includes("Library"), "should include Library");
    assert.ok(
        names.includes("Listen Together"),
        "should include Listen Together"
    );
    assert.ok(names.includes("Audiobooks"), "should include Audiobooks");
    assert.ok(names.includes("Podcasts"), "should include Podcasts");
});

test("sidebar navigation does not include removed items", () => {
    const names = SIDEBAR_NAVIGATION.map((item) => item.name);
    assert.ok(!names.includes("My Liked"), "should not include My Liked");
    assert.ok(!names.includes("Radio"), "should not include Radio");
    assert.ok(!names.includes("Discovery"), "should not include Discovery");
    assert.ok(!names.includes("Browse"), "should not include Browse");
});

test("mobile quick links start with Home then Explore", () => {
    assert.equal(MOBILE_QUICK_LINKS[0].name, "Home");
    assert.equal(MOBILE_QUICK_LINKS[0].href, "/");
    assert.equal(MOBILE_QUICK_LINKS[1].name, "Explore");
    assert.equal(MOBILE_QUICK_LINKS[1].href, "/explore");
});

test("mobile quick links include Listen Together", () => {
    const names = MOBILE_QUICK_LINKS.map((item) => item.name);
    assert.ok(
        names.includes("Listen Together"),
        "should include Listen Together"
    );
});

test("mobile quick links include both vibe destinations", () => {
    const hrefs = MOBILE_QUICK_LINKS.map((item) => item.href);
    assert.ok(hrefs.includes("/vibe"), "should include Vibe Explore");
    assert.ok(hrefs.includes("/vibe?tab=map"), "should include Vibe Map");
});
