/**
 * ALL user-facing copy for the weight mixer, x-ray verdicts, and the "?"
 * education popover lives here — data only, no logic. Editing text never
 * touches a component or the verdict engine.
 *
 * Verdict templates use {name} placeholders filled from VerdictLine.values
 * (see verdict.ts formatVerdict).
 */

import type { MixerComponent } from "./vibeMixer";

export interface DimensionCopy {
    /** Slider / row label. */
    label: string;
    /** One-liner under the knob. */
    knobHint: string;
    /** Longer explanation for the About popover's Dimensions section. */
    aboutBlurb: string;
}

export const DIMENSION_COPY: Record<MixerComponent, DimensionCopy> = {
    clap: {
        label: "Sound",
        knobHint: "Overall sonic texture — instrumentation, production, genre feel.",
        aboutBlurb:
            "A neural model (CLAP) listens to the middle of each track and places it by how it sounds — instruments, production style, genre palette. This is the default backbone of similarity and what positions dots on the map.",
    },
    lyricSemantic: {
        label: "Lyrics: meaning",
        knobHint: "What the words are about — themes and subject matter.",
        aboutBlurb:
            "A text model reads each song's lyrics and captures what they're about, so two songs about heartbreak match even when one is folk and one is metal. Only applies where lyrics were found and analyzed.",
    },
    lyricSentiment: {
        label: "Lyrics: mood",
        knobHint: "Emotional polarity of the words, bleak through euphoric.",
        aboutBlurb:
            "Lyric sentiment scored from bleak (−1) to euphoric (+1) — independent of how the music sounds, which is how a happy-sounding sad song gets caught. English-centric; other languages score unreliably.",
    },
    lyricLexical: {
        label: "Lyrics: vocabulary",
        knobHint: "Wordsmith vs. repetition — how varied the vocabulary is.",
        aboutBlurb:
            "Lexical diversity (MTLD): how many different words a lyricist uses before repeating themselves, computed so long songs aren't penalized. Dense wordplay scores high; chant-alongs score low. Neither is better — it's a flavor axis.",
    },
    lyricReading: {
        label: "Lyrics: complexity",
        knobHint: "Reading level of the words (each line read as a sentence).",
        aboutBlurb:
            "Flesch-Kincaid grade level of the lyrics, treating each line as a sentence. English-centric and rough — think of it as plainspoken vs. ornate.",
    },
    energy: {
        label: "Energy",
        knobHint: "Intensity and drive, calm through ferocious.",
        aboutBlurb:
            "Signal-level intensity extracted from the audio. This is the dial that separates the ballad from the banger even when they share a sound palette.",
    },
    valence: {
        label: "Brightness",
        knobHint: "How positive the music itself sounds.",
        aboutBlurb:
            "Musical positivity (valence) estimated from the audio alone — bright major-key bounce vs. dark brooding. Compare with Lyrics: mood to find songs that sound happy but read sad.",
    },
    bpm: {
        label: "Tempo",
        knobHint: "Beats per minute, with half/double-time treated as kin.",
        aboutBlurb:
            "Tempo matching folds half- and double-time together (a 70 BPM head-nodder and a 140 BPM double-time feel are closer than the raw numbers suggest), the way DJs think about it.",
    },
    danceability: {
        label: "Groove",
        knobHint: "How much it makes you move.",
        aboutBlurb:
            "Rhythmic regularity and groove strength from a dance-trained model — steady four-on-the-floor scores high, rubato ballads score low.",
    },
    acousticness: {
        label: "Acoustic",
        knobHint: "Unplugged vs. produced/electronic.",
        aboutBlurb:
            "How acoustic the arrangement sounds — wooden and roomy at one end, synthesized and produced at the other.",
    },
    instrumentalness: {
        label: "Instrumental",
        knobHint: "Vocal-forward vs. instrumental.",
        aboutBlurb:
            "Likelihood the track has no (or buried) vocals. Useful to keep focus playlists free of singing, or to hunt vocal-forward versions of a vibe.",
    },
    key: {
        label: "Key",
        knobHint: "Harmonic compatibility on the Camelot wheel.",
        aboutBlurb:
            "Musical key compared on the Camelot wheel DJs use: same key mixes perfectly, relative major/minor and neighboring keys mix well, distant keys clash. A subtle seasoning weight, not a main dish.",
    },
};

/** {name} placeholders are filled from VerdictLine.values. */
export const VERDICT_TEMPLATES: Record<string, string> = {
    "sonic-identical": "Nearly identical sonic texture — same production palette.",
    "sonic-alike": "Clearly alike in sound — {percent}% sonic match.",
    "sonic-loose": "Loosely related sound worlds — {percent}% sonic match.",
    "sonic-different": "Different sound worlds — only {percent}% sonic match.",
    "sonic-unknown": "No sonic comparison available (a track hasn't been analyzed yet).",
    "gap-callout": "…but {dimension} differs by {percent}% — that gap is what your ears notice.",
    "tempo-apart": "Tempos sit {bpm} BPM apart.",
    "key-same": "Same key ({label}) — they mix seamlessly.",
    "key-relative": "Relative keys ({labelA} / {labelB}) — harmonically joined at the hip.",
    "key-adjacent": "Neighboring keys ({labelA} / {labelB}) — an easy, clean blend.",
    "key-distant": "Distant keys ({labelA} / {labelB}) — harmonically they'll clash.",
    "lyrics-similar-themes": "The lyrics are singing about similar things ({percent}% match).",
    "lyrics-opposite-polarity": "Opposite emotional polarity in the words — one reads bright, the other bleak.",
    "lyrics-not-applicable": "Lyric dials don't apply here — no analyzed lyrics on at least one side.",
};

/** Intro line for the About popover's Dimensions section. */
export const ABOUT_DIMENSIONS_INTRO =
    "Similarity here isn't one number — it's a mix you control. Each dimension below is measured per track; the mixer's sliders decide how much each one counts. Lyric dimensions are English-centric and only apply where lyrics were found.";
