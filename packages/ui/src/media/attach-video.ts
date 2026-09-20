/**
 * The hero video's attach decision, as pure functions.
 *
 * docs/08 §6 makes the video hero free by never letting it be an LCP candidate: the poster is a real
 * `<img>`, the `<video>` ships with no `src` and no `poster`, and a small island attaches the source
 * *after* LCP is final. What the island then has to decide is whether to attach at all, and that
 * decision has four inputs and three ways of being wrong. So it lives here, where it can be driven
 * without a browser, and the island is the thin part that reads the DOM and applies the answer.
 *
 * ## Pure, and deliberately DOM-free
 *
 * No `HTMLVideoElement`, no `PerformanceResourceTiming`, no `navigator` type. This file is in the root
 * typecheck project, which has no DOM lib — the same discipline `motion/bootstrap.ts` keeps, and for the
 * same reason: a module that cannot reach `document` cannot grow a branch that only a browser can
 * explain. Everything it needs arrives as a structural shape.
 *
 * ## Why the reduced-motion answer is read from a token and not from `matchMedia`
 *
 * Two reasons, and the second one is a defect `matchMedia` would have shipped.
 *
 * `pnpm layout` asserts that `prefers-reduced-motion` is authored in exactly ONE file
 * (`packages/ui/src/tokens/scale.ts`), because docs/08 §5 makes reduced motion a token override rather
 * than a per-component branch. An island spelling the query again would be the second authored copy, and
 * the rule exists precisely so that the second copy is a build failure rather than a divergence nobody
 * reviews with the setting on.
 *
 * And the token layer answers a *narrower* question than the media query does. The override is written
 * `@media (prefers-reduced-motion: reduce) { :root:not([data-motion="full"]) { --dur-ambient: 0s; … } }`
 * — so a reader who has opted into full motion has the media query matching and the tokens at their full
 * values. An island asking `matchMedia` would refuse that reader's video while every duration and
 * distance on the page ran at full length: the escape hatch would be live for the whole design system and
 * dead for the one element it is most likely to be used for. Reading `--dur-ambient` asks the question the
 * system actually answers — "is ambient motion wanted here" — and a looping hero is ambient motion by
 * definition.
 *
 * ## Why the slow-connection gate is a measurement and not `saveData`
 *
 * docs/08 §6: "Slow-connection gate that works cross-browser (not just Chrome's `saveData`):
 * `PerformanceResourceTiming` → `(transferSize * 8) / duration < 600 kbit/s` → serve the still."
 * `navigator.connection` does not exist in Safari at all, which is most of the traffic on the device the
 * booking happens on, so a gate built on it is a gate that never fires for the readers it was written
 * for. The measurement is of resources this page has *already* downloaded, which is the one number that
 * is always available and always about this connection.
 *
 * `saveData` is still honoured when it is there, because an explicit "do not spend my data" is a stated
 * preference and a megabyte of decoration is exactly what it is about — but nothing here *depends* on it.
 * `attach-video.test.ts` drives a navigator with no `connection` object for that reason.
 */

/** `requestIdleCallback`'s timeout, from docs/08 §6. */
export const HERO_ATTACH_IDLE_TIMEOUT_MS = 2500

/**
 * How long after `load` the island waits when there is no `requestIdleCallback`.
 *
 * docs/08 §6's "or load + 400ms". Safari has no `requestIdleCallback`, so this is not a rare path — it
 * is the path on every iPhone, which is the device this hero is budgeted for.
 */
export const HERO_ATTACH_LOAD_DELAY_MS = 400

/**
 * The floor, in kbit/s. docs/08 §6.
 *
 * 600 kbit/s is roughly where the 350KB mobile rendition stops arriving inside five seconds, which is the
 * point at which the still is simply better than the video — the reader gets the photograph now instead of
 * a decoration later, and pays nothing for it.
 */
export const HERO_MIN_DOWNLINK_KBPS = 600

/**
 * The smallest response that says anything about bandwidth, in bytes.
 *
 * A 300-byte response's duration is latency, not throughput: measured over one of them a 100 Mbit link
 * reports about 20 kbit/s, and the gate would refuse the video on every fast connection on the site. Four
 * kilobytes is the first size where the transfer itself is most of the time.
 */
export const HERO_MIN_SAMPLE_BYTES = 4096

/** The attribute the hero's state is published on, read by the stylesheet and by the tests. */
export const HERO_STATE_ATTRIBUTE = 'data-hero-state'

/** Why the island is holding the still. Set only alongside `held`, so a hold is never unexplained. */
export const HERO_HOLD_ATTRIBUTE = 'data-hero-hold'

/** The control's state, and what its label must say. */
export const HERO_CONTROL_ATTRIBUTE = 'data-hero-control'

/**
 * The prefix of the two attributes carrying the control's localised names.
 *
 * `data-hero-label-pause` and `data-hero-label-play`. The island sets an accessible name and must not be
 * the thing that knows the language: an island with copy in it is an island that has to be built twice,
 * and the one on the Arabic document would be the copy nobody checked.
 */
export const HERO_CONTROL_LABEL_ATTRIBUTE = 'data-hero-label'

/** The `<source>` list, as JSON, on the `<video>`. Data, not a URL: nothing fetches an attribute. */
export const HERO_SOURCES_ATTRIBUTE = 'data-hero-sources'

/** The custom property the reduced-motion override zeroes. `12s` normally, `0s` under reduce. */
export const HERO_AMBIENT_PROPERTY = '--dur-ambient'

/** The custom property this component's stylesheet clears under `prefers-reduced-transparency`. */
export const HERO_VIDEO_PROPERTY = '--hero-video'

/**
 * The hero's states.
 *
 * `still` is what the server renders: the poster is up, the video is empty, and nothing has been decided.
 * `attaching` is the only state in which the video is transparent — see the note on the cross-fade in
 * `styles.ts` for why the *server* does not render it that way.
 */
export const HERO_STATES = ['still', 'attaching', 'playing', 'paused', 'held'] as const
export type HeroState = (typeof HERO_STATES)[number]

/**
 * The control's three states.
 *
 * `hidden` is not "no control". It is "there is no moving content on this page", which is the case in
 * which WCAG 2.2.2 asks for nothing and a play button would be an invitation to download a megabyte the
 * reader has already been spared. `play` is docs/08 §6's tap-to-play.
 */
export const HERO_CONTROLS = ['hidden', 'pause', 'play'] as const
export type HeroControl = (typeof HERO_CONTROLS)[number]

/**
 * Why the video was not attached, or was given up on. Named, so a test can assert the reason.
 *
 * A single boolean would make every one of these look like the same page, and three of them are
 * conditions somebody will want to see in the field: a hold nobody can name is a hero that is
 * "sometimes a photograph" in a bug report.
 */
export const HERO_HOLD_REASONS = [
  'reduced-motion',
  'reduced-transparency',
  'slow-connection',
  'data-saver',
  'reader-paused',
  'no-renditions-declared',
  'playback-refused',
] as const
export type HeroHoldReason = (typeof HERO_HOLD_REASONS)[number]

/** The reader's remembered choice, stored at `MOTION_STORAGE_KEY`. */
export const MOTION_CHOICES = ['playing', 'paused'] as const
export type MotionChoice = (typeof MOTION_CHOICES)[number]

/**
 * The stored choice, or null for "never asked".
 *
 * Null and not a default, because the two are different decisions: no stored value means the design's own
 * behaviour applies, and a stored `playing` means the reader has pressed play on this site before. A
 * value from another version of this site, or a hand-edited one, reads as null rather than throwing —
 * `localStorage` is user-writable and a hero that fails to render on a malformed string is a hero a
 * console line can break.
 */
export function parseMotionChoice(raw: string | null | undefined): MotionChoice | null {
  return MOTION_CHOICES.find((choice) => choice === raw) ?? null
}

/** The reduced-motion answer, read out of the token the override zeroes. */
export function motionIsReduced(ambientDuration: string | null | undefined): boolean {
  const text = (ambientDuration ?? '').trim()
  const match = /^(-?\d*\.?\d+)(s|ms)$/.exec(text)
  // Unparseable — an empty string, a `var()` that resolved to nothing, a stylesheet that never loaded —
  // reads as REDUCED. The fail-safe direction is the one that plays nothing: a reader who asked for no
  // motion and got some has had a symptom inflicted on them, and a reader who asked for motion and got a
  // photograph has seen the poster, which is what the whole design is built around anyway.
  if (match?.[1] === undefined || match[2] === undefined) return true
  return Number.parseFloat(match[1]) === 0
}

/**
 * The reduced-transparency answer, read out of this component's own flag.
 *
 * `0` means the hero's stylesheet is inside `@media (prefers-reduced-transparency: reduce)`. A moving
 * photograph under the scrim that the headline's contrast is measured against is the transparency problem
 * with a time axis: the measured ratio holds for one frame of it. docs/08 §8 already drops the header's
 * blur there; this drops the thing the blur was over.
 */
export function transparencyIsReduced(flag: string | null | undefined): boolean {
  return (flag ?? '').trim() === '0'
}

/** The two fields of a resource timing this gate reads. Structural, so no DOM lib is needed. */
export interface ResourceTimingSample {
  /** Bytes over the wire, including headers. `0` for a cached or opaque response. */
  readonly transferSize: number
  /** Milliseconds. `transferSize * 8 / duration` is therefore kbit/s with no conversion. */
  readonly duration: number
}

/**
 * The best throughput this page has actually observed, in kbit/s, or null when nothing measurable
 * has been downloaded.
 *
 * **The maximum, not the mean.** A resource's `duration` includes whatever time it spent queued behind
 * six other requests, so the slowest sample on a fast connection is a measurement of the queue. The
 * fastest sample is the closest thing a page has to the link's capacity, and the gate is a floor: the
 * question is "is this connection at least 600 kbit/s", and one resource that arrived faster than that
 * answers it.
 *
 * Null when every response was cached (`transferSize: 0`) or too small to time. Null is **not** slow:
 * a warm cache is not evidence of a bad connection, and refusing the video to the reader who comes back
 * most often would be exactly the wrong way round.
 */
export function measuredDownlinkKbps(samples: readonly ResourceTimingSample[]): number | null {
  let best: number | null = null
  for (const sample of samples) {
    // `Number.isFinite` first, because an engine that does not implement `transferSize` returns undefined
    // and `NaN < 4096` is false: the size check alone would let a NaN through and make the best observed
    // throughput NaN, which compares false against the floor and would attach the video on every
    // connection. Found by writing the sample down before the comparison.
    if (!Number.isFinite(sample.transferSize) || !Number.isFinite(sample.duration)) continue
    if (sample.transferSize < HERO_MIN_SAMPLE_BYTES || sample.duration <= 0) continue
    const kbps = (sample.transferSize * 8) / sample.duration
    if (best === null || kbps > best) best = kbps
  }
  return best
}

/** `navigator.connection`, as much of it as this module reads. Everything optional; Safari has none. */
export interface ConnectionHint {
  readonly saveData?: boolean
}

export interface NavigatorHint {
  readonly connection?: ConnectionHint | undefined
}

export interface HeroAttachInput {
  /** Computed `--dur-ambient` on the document element. */
  readonly ambientDuration: string | null
  /** Computed `--hero-video` on the document element. */
  readonly videoFlag: string | null
  /** Whatever is at `localStorage['berelax:motion']`, unvalidated. */
  readonly storedChoice: string | null
  /** Every resource timing the page has, unfiltered. */
  readonly samples: readonly ResourceTimingSample[]
  /** How many `<source>` candidates the server declared for this viewport. */
  readonly declaredSources: number
  /** The navigator, which may have no `connection` at all. */
  readonly navigator: NavigatorHint
  /** True when the reader has just pressed play. Their gesture outranks every gate but the two token ones. */
  readonly readerAsked?: boolean
}

export interface HeroAttachDecision {
  readonly attach: boolean
  /** Null exactly when `attach` is true. */
  readonly reason: HeroHoldReason | null
  readonly control: HeroControl
  /** The measurement the slow-connection gate made, for a log line and for a test. */
  readonly downlinkKbps: number | null
}

/**
 * Whether to attach the hero video, and what the control must then say.
 *
 * The order of the gates is the design, not an implementation detail:
 *
 * 1. **Reduced motion** is absolute and is checked first, and the control stays hidden — there is no
 *    moving content, so WCAG 2.2.2 asks for no control, and offering a play button to a reader who asked
 *    for no motion is asking them to re-state the preference they already set. docs/08 §9's Motion
 *    setting (`[data-motion="full"]`) is the documented way back to full motion, and it reaches this
 *    function through `--dur-ambient` like everything else.
 * 2. **Reduced transparency**, for the reason `transparencyIsReduced` gives.
 * 3. **The reader's own choice**, which is the one hold that shows a control: they paused it, so the
 *    thing to offer is play.
 * 4. **The gates about bytes** — data saver, then the measured floor. A reader's gesture (`readerAsked`)
 *    skips these: they have been shown the still, they have asked for the video anyway, and refusing a
 *    direct request in order to save their data is a decision that is no longer ours to make.
 */
export function heroAttachDecision(input: HeroAttachInput): HeroAttachDecision {
  const downlinkKbps = measuredDownlinkKbps(input.samples)
  const hold = (reason: HeroHoldReason, control: HeroControl): HeroAttachDecision => ({
    attach: false,
    reason,
    control,
    downlinkKbps,
  })

  if (motionIsReduced(input.ambientDuration)) return hold('reduced-motion', 'hidden')
  if (transparencyIsReduced(input.videoFlag)) return hold('reduced-transparency', 'hidden')
  if (input.declaredSources <= 0) return hold('no-renditions-declared', 'hidden')

  const asked = input.readerAsked === true
  if (!asked && parseMotionChoice(input.storedChoice) === 'paused') {
    return hold('reader-paused', 'play')
  }
  if (!asked && input.navigator.connection?.saveData === true) return hold('data-saver', 'play')
  if (!asked && downlinkKbps !== null && downlinkKbps < HERO_MIN_DOWNLINK_KBPS) {
    // The control stays hidden: a play button here is a 350KB download offered to somebody whose
    // connection has just been measured too slow to carry it, and the still is what docs/08 §8's cut
    // order calls for anyway.
    return hold('slow-connection', 'hidden')
  }
  return { attach: true, reason: null, control: 'pause', downlinkKbps }
}
