import fs from "fs";
import path from "path";
import {
    DEFAULT_SIMILARITY_WEIGHTS,
    SIMILARITY_COMPONENTS,
} from "../services/similarityWeights";

/**
 * Cross-boundary contract: the frontend weight mixer
 * (frontend/components/vibe/vibeMixer.ts) mirrors the backend's similarity
 * component list and default weights so the map's live client-side recolor
 * agrees with server-side /similar scoring under the same stored mix. Nothing
 * else pins the two lists to each other — the frontend's own unit test only
 * asserts the list length — so a drifted key or default would ship silently.
 *
 * Same idiom as the audioAnalyzer*Contract suites (which pin Python source):
 * the frontend module is read as text because backend tsconfig's
 * rootDir:'./src' forbids importing it, and the CI frontend job never
 * installs backend deps for the reverse direction. The literals below are
 * executed for real by frontend/tests/unit/vibeMixer.test.ts.
 */

function readVibeMixerSource(): string {
    const mixerPath = path.resolve(
        __dirname,
        "../../../frontend/components/vibe/vibeMixer.ts"
    );
    if (!fs.existsSync(mixerPath)) {
        throw new Error(
            `frontend/components/vibe/vibeMixer.ts not found at ${mixerPath} — ` +
                "if the mixer module moved, update this contract test's path"
        );
    }
    return fs.readFileSync(mixerPath, "utf8");
}

function extractBlock(source: string, startMarker: string): string {
    const start = source.indexOf(startMarker);
    if (start === -1) {
        throw new Error(`Missing marker in vibeMixer.ts: ${startMarker}`);
    }
    const openBracket = source.indexOf(
        startMarker.includes("[") ? "[" : "{",
        start
    );
    const closeChar = startMarker.includes("[") ? "]" : "}";
    const end = source.indexOf(closeChar, openBracket);
    if (openBracket === -1 || end === -1) {
        throw new Error(`Unterminated block after marker: ${startMarker}`);
    }
    return source.slice(openBracket + 1, end);
}

describe("frontend weight-mixer ↔ backend similarity-weights contract", () => {
    const source = readVibeMixerSource();

    it("MIXER_COMPONENTS matches SIMILARITY_COMPONENTS exactly, in order", () => {
        const block = extractBlock(source, "export const MIXER_COMPONENTS = [");
        const frontendComponents = [...block.matchAll(/"([^"]+)"/g)].map(
            (m) => m[1]
        );
        expect(frontendComponents).toEqual([...SIMILARITY_COMPONENTS]);
    });

    it("DEFAULT_WEIGHTS matches DEFAULT_SIMILARITY_WEIGHTS value-for-value", () => {
        const block = extractBlock(
            source,
            "export const DEFAULT_WEIGHTS: MixerWeights = {"
        );
        const frontendDefaults: Record<string, number> = {};
        for (const m of block.matchAll(/(\w+):\s*([0-9.]+)/g)) {
            frontendDefaults[m[1]] = Number(m[2]);
        }
        expect(frontendDefaults).toEqual(DEFAULT_SIMILARITY_WEIGHTS);
    });
});
