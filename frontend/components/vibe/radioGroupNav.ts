/**
 * radioGroupNav — pure keyboard math for role="radiogroup" controls
 * (review finding D7): the roving-tabindex pattern where arrow keys move
 * BOTH selection and focus, wrapping at the ends and skipping disabled
 * options, per the WAI-ARIA radio-group pattern.
 *
 * No React, no DOM — unit-testable in isolation. Components apply it as:
 * tabIndex = option === current ? 0 : -1, and on keydown select+focus
 * `radioTargetFor(...)`'s result when non-null.
 */

/**
 * The option arrow/Home/End navigation should move to, or null when `key`
 * is not a radio-group navigation key (leave the event alone — Tab must
 * keep leaving the group). Wraps; skips options where `isDisabled` returns
 * true; returns null when every other option is disabled.
 */
export function radioTargetFor<T>(
    key: string,
    options: readonly T[],
    current: T,
    isDisabled: (option: T) => boolean = () => false
): T | null {
    const count = options.length;
    if (count === 0) return null;

    const enabled = (candidate: T) => !isDisabled(candidate);
    const from = Math.max(0, options.indexOf(current));

    const step = (delta: 1 | -1): T | null => {
        for (let hop = 1; hop <= count; hop++) {
            const candidate =
                options[(from + delta * hop + count * hop) % count];
            if (candidate === current) return null; // wrapped all the way
            if (enabled(candidate)) return candidate;
        }
        return null;
    };

    switch (key) {
        case "ArrowRight":
        case "ArrowDown":
            return step(1);
        case "ArrowLeft":
        case "ArrowUp":
            return step(-1);
        case "Home":
            return options.find(enabled) ?? null;
        case "End": {
            for (let i = count - 1; i >= 0; i--) {
                if (enabled(options[i])) return options[i];
            }
            return null;
        }
        default:
            return null;
    }
}

/** tabIndex for a roving-radio option: the checked option is the group's
 * single Tab stop; everything else is reachable only by arrows. */
export function rovingTabIndex<T>(option: T, current: T): 0 | -1 {
    return option === current ? 0 : -1;
}
