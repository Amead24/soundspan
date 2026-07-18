import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    pathname: "/library",
    search: "",
    isAuthenticated: true,
    hasActiveSessions: false,
    isMobile: false,
    isTablet: false,
};

mock.module("next/navigation", {
    namedExports: {
        usePathname: () => state.pathname,
        useSearchParams: () => new URLSearchParams(state.search),
    },
});

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    }) =>
        React.createElement("a", { href, ...rest }, children),
});

mock.module("next/image", {
    defaultExport: ({
        src,
        alt,
        ...rest
    }: {
        src: string;
        alt: string;
    }) => React.createElement("img", { src, alt, ...rest }),
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            scanLibrary: async () => undefined,
            getPlaylists: async () => [],
        },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ isAuthenticated: state.isAuthenticated }),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: null,
            currentAudiobook: null,
            currentPodcast: null,
            playbackType: "track",
        }),
    },
});

mock.module("@/hooks/useActiveListenSessions", {
    namedExports: {
        useActiveListenSessions: () => state.hasActiveSessions,
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        useLikedPlaylistQuery: () => ({
            data: null,
            isLoading: false,
            isError: false,
        }),
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => state.isMobile,
        useIsTablet: () => state.isTablet,
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                error: () => undefined,
                success: () => undefined,
            },
        }),
    },
});

mock.module("@/components/ui/EqBars", {
    namedExports: {
        EqBars: () => React.createElement("span", null, "eq-bars"),
    },
});

mock.module("../../components/layout/MobileSidebar.tsx", {
    namedExports: {
        MobileSidebar: () => React.createElement("div", null, "mobile-sidebar"),
    },
});

beforeEach(() => {
    state.pathname = "/library";
    state.search = "";
    state.isAuthenticated = true;
    state.hasActiveSessions = false;
    state.isMobile = false;
    state.isTablet = false;
});

test("renders the mobile drawer instead of the desktop aside on mobile", async () => {
    state.isMobile = true;

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.match(html, /mobile-sidebar/);
    assert.doesNotMatch(html, /<aside/);
});

test("returns null for auth routes", async () => {
    state.pathname = "/login";

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.equal(html, "");
});

test("renders social navigation without my history link", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.match(html, />Explore</);
    assert.match(html, />Library</);
    assert.match(html, />Listen Together</);
    assert.match(html, />Audiobooks</);
    assert.match(html, />Podcasts</);
    assert.doesNotMatch(html, /My History/);
});

test("renders vibe explore and vibe map navigation entries", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.match(html, />Vibe Explore</);
    assert.match(html, />Vibe Map</);
    assert.ok(html.includes('href="/vibe"'), "expected a /vibe link");
    assert.ok(
        html.includes('href="/vibe?tab=map"'),
        "expected a /vibe?tab=map link"
    );
});

test("marks vibe explore active on /vibe without a tab param", async () => {
    state.pathname = "/vibe";

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    const exploreLink = html.match(/<a[^>]*href="\/vibe"[^>]*>/);
    const mapLink = html.match(/<a[^>]*href="\/vibe\?tab=map"[^>]*>/);
    assert.ok(exploreLink && mapLink, "expected both vibe links");
    assert.match(exploreLink[0], /aria-current="page"/);
    assert.doesNotMatch(mapLink[0], /aria-current/);
});

test("renders a badge chip when a nav item declares one", async () => {
    const { SidebarNavLinks } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(
        React.createElement(SidebarNavLinks, {
            pathname: "/",
            search: "",
            isMobileOrTablet: false,
            hasActiveSessions: false,
            items: [{ name: "Radio", href: "/radio", badge: "BETA" }],
        })
    );

    assert.match(html, />Radio</);
    assert.match(html, />BETA</);
});

test("marks vibe map active when the tab param is map", async () => {
    state.pathname = "/vibe";
    state.search = "tab=map";

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    const exploreLink = html.match(/<a[^>]*href="\/vibe"[^>]*>/);
    const mapLink = html.match(/<a[^>]*href="\/vibe\?tab=map"[^>]*>/);
    assert.ok(exploreLink && mapLink, "expected both vibe links");
    assert.match(mapLink[0], /aria-current="page"/);
    assert.doesNotMatch(exploreLink[0], /aria-current/);
});

test("shows listen-together equalizer marker when active sessions exist", async () => {
    state.hasActiveSessions = true;
    state.pathname = "/listen-together";

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.match(html, /eq-bars/);
});

test("keeps prefetch enabled for primary sidebar navigation links", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    const navHrefs = [
        "/explore",
        "/vibe",
        "/vibe?tab=map",
        "/library",
        "/listen-together",
        "/audiobooks",
        "/podcasts",
    ];

    for (const href of navHrefs) {
        const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const linkMatch = html.match(
            new RegExp(`<a[^>]*href="${escapedHref}"[^>]*>`)
        );
        assert.ok(linkMatch, `Expected link for ${href}`);
        assert.doesNotMatch(
            linkMatch[0],
            /\sprefetch=/,
            `Primary nav link ${href} should not force prefetch off`
        );
    }
});
