import assert from "node:assert/strict";
import test from "node:test";
import {
    getActiveNavHref,
    hasMyHistoryLink,
    MOBILE_QUICK_LINKS,
    SIDEBAR_NAVIGATION,
} from "../../components/layout/socialNavigation";

test("sidebar and mobile navigation do not include my-history", () => {
    assert.equal(hasMyHistoryLink(SIDEBAR_NAVIGATION), false);
    assert.equal(hasMyHistoryLink(MOBILE_QUICK_LINKS), false);
});

test("hasMyHistoryLink returns true when my-history entry exists", () => {
    assert.equal(
        hasMyHistoryLink([
            { href: "/library" },
            { href: "/my-history" },
            { href: "/settings" },
        ]),
        true
    );
});

test("hasMyHistoryLink short-circuits when my-history is the first entry", () => {
    assert.equal(
        hasMyHistoryLink([
            { href: "/my-history" },
            { href: "/library" },
        ]),
        true
    );
});

test("hasMyHistoryLink returns false for empty navigation", () => {
    assert.equal(hasMyHistoryLink([]), false);
});

test("quick links and sidebar include listen together destination", () => {
    assert.equal(
        MOBILE_QUICK_LINKS.some((link) => link.href === "/listen-together"),
        true
    );
    assert.equal(
        SIDEBAR_NAVIGATION.some((link) => link.href === "/listen-together"),
        true
    );
});

test("navigation exposes explore as default landing destination", () => {
    assert.equal(
        SIDEBAR_NAVIGATION.some((link) => link.href === "/explore"),
        true
    );
    assert.equal(
        MOBILE_QUICK_LINKS.some((link) => link.href === "/explore"),
        true
    );
});

test("SIDEBAR_NAVIGATION does not include /import", () => {
    const importItem = SIDEBAR_NAVIGATION.find(
        (item) => item.href === "/import"
    );
    assert.equal(importItem, undefined, "Import should not be in sidebar");
});

test("MOBILE_QUICK_LINKS does not include /import", () => {
    const importItem = MOBILE_QUICK_LINKS.find(
        (item) => item.href === "/import"
    );
    assert.equal(importItem, undefined, "Import should not be in mobile links");
});

test("getActiveNavHref matches a plain pathname with no query", () => {
    assert.equal(
        getActiveNavHref("/library", "", SIDEBAR_NAVIGATION),
        "/library"
    );
});

test("getActiveNavHref returns null when no item matches the pathname", () => {
    assert.equal(getActiveNavHref("/settings", "", SIDEBAR_NAVIGATION), null);
});

test("getActiveNavHref keeps the paramless vibe entry active without ?tab", () => {
    assert.equal(getActiveNavHref("/vibe", "", SIDEBAR_NAVIGATION), "/vibe");
});

test("getActiveNavHref prefers the most specific query match for the map tab", () => {
    assert.equal(
        getActiveNavHref("/vibe", "tab=map", SIDEBAR_NAVIGATION),
        "/vibe?tab=map"
    );
});

test("getActiveNavHref ignores unrelated query params", () => {
    assert.equal(
        getActiveNavHref("/vibe", "trackId=abc123", SIDEBAR_NAVIGATION),
        "/vibe"
    );
    assert.equal(
        getActiveNavHref("/vibe", "tab=map&trackId=abc123", SIDEBAR_NAVIGATION),
        "/vibe?tab=map"
    );
});

test("getActiveNavHref rejects items whose declared param mismatches", () => {
    assert.equal(
        getActiveNavHref("/vibe", "tab=explore", [
            { href: "/vibe?tab=map" },
        ]),
        null
    );
});

test("getActiveNavHref requires every declared param to match", () => {
    const items = [{ href: "/vibe?tab=map&zoom=close" }, { href: "/vibe" }];
    assert.equal(getActiveNavHref("/vibe", "tab=map", items), "/vibe");
    assert.equal(
        getActiveNavHref("/vibe", "tab=map&zoom=close", items),
        "/vibe?tab=map&zoom=close"
    );
});

test("getActiveNavHref keeps the first item on specificity ties", () => {
    const items = [{ href: "/vibe" }, { href: "/vibe" }];
    assert.equal(getActiveNavHref("/vibe", "", items), "/vibe");
});
