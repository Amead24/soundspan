export interface SidebarNavigationItem {
    name: string;
    href: string;
    badge?: string;
}

export interface MobileQuickLinkItem {
    name: string;
    href: string;
}

export const SIDEBAR_NAVIGATION: SidebarNavigationItem[] = [
    { name: "Home", href: "/" },
    { name: "Explore", href: "/explore" },
    { name: "Vibe Explore", href: "/vibe" },
    { name: "Vibe Map", href: "/vibe?tab=map" },
    { name: "Library", href: "/library" },
    { name: "Listen Together", href: "/listen-together" },
    { name: "Audiobooks", href: "/audiobooks" },
    { name: "Podcasts", href: "/podcasts" },
];
// No blank line above on purpose (issue #111) — see check-targeted-coverage.mjs.
export const MOBILE_QUICK_LINKS: MobileQuickLinkItem[] = [
    { name: "Home", href: "/" },
    { name: "Explore", href: "/explore" },
    { name: "Vibe Explore", href: "/vibe" },
    { name: "Vibe Map", href: "/vibe?tab=map" },
    { name: "Listen Together", href: "/listen-together" },
];

/**
 * Executes hasMyHistoryLink.
 */
export function hasMyHistoryLink(
    links: ReadonlyArray<{ href: string }>
): boolean {
    return links.some((link) => link.href === "/my-history");
}

/**
 * Resolves which nav item is active for the current location. Item hrefs may
 * carry a query string (e.g. "/vibe?tab=map"): an item matches when its
 * pathname and every query param it declares match the current URL, and the
 * most specific match (most declared params) wins, so "/vibe" stays the
 * fallback while "/vibe?tab=map" claims the map tab.
 *
 * Array methods and single-line statements on purpose (issue #111): an
 * explicit for/continue loop or multi-line statements smear the tsx
 * transform's targeted-coverage line mapping.
 */
export function getActiveNavHref(pathname: string, search: string, items: ReadonlyArray<{ href: string }>): string | null {
    const current = new URLSearchParams(search);
    const initial = { href: null as string | null, specificity: -1 };
    const scored = items.map((item) => ({ href: item.href, specificity: navHrefSpecificity(item.href, pathname, current) }));
    const best = scored.reduce((acc, entry) => (entry.specificity > acc.specificity ? entry : acc), initial);
    return best.href;
}

function navHrefSpecificity(href: string, pathname: string, current: URLSearchParams): number {
    const queryIndex = href.indexOf("?");
    const path = queryIndex === -1 ? href : href.slice(0, queryIndex);
    if (path !== pathname) {
        return -1;
    }
    const query = queryIndex === -1 ? "" : href.slice(queryIndex + 1);
    const required = Array.from(new URLSearchParams(query).entries());
    const allMatch = required.every(([key, value]) => current.get(key) === value);
    return allMatch ? required.length : -1;
}
