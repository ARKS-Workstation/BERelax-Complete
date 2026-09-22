/**
 * Everything that has to be nailed down before a screenshot is worth comparing.
 *
 * A visual-regression gate is only as good as its false-positive rate. One flapping pixel and people
 * start approving diffs without looking, which is worse than having no gate — the gate is still red,
 * everyone has stopped reading it, and the one real regression goes through with the noise.
 *
 * So each of these closes a specific source of variation, and the acceptance criterion is the blunt
 * one: two consecutive runs on unchanged input produce **byte-identical** PNGs.
 */
import { createHash } from 'node:crypto'
import type { PageGlobalsForHarness } from './page-globals.ts'

/**
 * The Chromium flags a repeat capture depends on.
 *
 * These live here, beside the CSS and the frozen clock, because they are the same claim expressed at a
 * lower level, and because a caller who writes their own list gets a screenshot gate that passes locally
 * and flaps under load. Two tests did exactly that — `breakpoint-preview.itest.ts` and
 * `messages-inbox.itest.ts` launched with `--no-sandbox` and `--font-render-hinting=none` alone — and
 * both failed their own byte-identical assertions intermittently while every capture through
 * `packages/harness/src/capture.ts` stayed stable.
 *
 * `--disable-skia-runtime-opts` is the one that matters most and the one nobody guesses: without it Skia
 * selects runtime-optimised raster paths from CPU feature detection, so the SAME image can rasterise
 * differently between two captures in one session, which is why the failures correlated with load rather
 * than with anything on the page. `--disable-lcd-text` removes subpixel antialiasing,
 * `--force-color-profile=srgb` pins the profile the host would otherwise supply, and `--hide-scrollbars`
 * stops a scrollbar appearing in one capture and not the other.
 */
export const DETERMINISTIC_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  // Host-dependent hinting and subpixel antialiasing are the two things that make the same page
  // render differently on two machines. Neither is worth a visual gate that only works locally.
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--disable-skia-runtime-opts',
] as const

/**
 * CSS injected before capture.
 *
 * `animation: none` rather than `animation-duration: 0s`: a zero-duration animation still applies its
 * final keyframe, and an element that animates *to* `opacity: 0` would vanish. `none` leaves every
 * element in its authored state.
 *
 * The caret is hidden because a focused input blinks, and a blinking caret is a pixel that differs
 * depending on when the shutter opened. Scroll behaviour is made instant because a smooth scroll can
 * still be in flight when the screenshot is taken.
 */
export const DETERMINISM_CSS = `
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
/* A video frame depends on when it was decoded. Posters and placeholders do not. */
video { visibility: hidden !important; }
/* The reduced-motion token override is belt to the braces above: it also zeroes movement tokens
   that a component might read in JavaScript rather than in CSS. */
:root {
  --dur-instant: 0ms; --dur-fast: 0ms; --dur-base: 0ms;
  --dur-slow: 0ms; --dur-reveal: 0ms; --dur-ambient: 0s;
  --move-sm: 0px; --move-md: 0px; --move-lg: 0px; --stagger: 0ms;
}
`

/**
 * Runs inside the page, before capture.
 *
 * Freezes the clock and the random number generator, because a page that renders "today" or shuffles
 * a testimonial list produces a different image every day. The frozen instant is the fixture salon's,
 * so a screenshot and a seeded database agree about what day it is.
 */
/**
 * A capture the page agrees with twice running.
 *
 * ## Why this is not "screenshot twice and compare"
 *
 * Two tests assert that a page renders identically on a repeat capture, and the claim they are making is
 * about the PAGE: a document printing a relative time or a freshly generated id could not do it. Both
 * expressed that as "capture one must equal capture two", which asserts something else as well — that
 * paint had settled by the first capture. Those are different claims, and the second one is not true
 * under load. Both tests flapped for days on this 4-core box whenever several worktrees ran their suites
 * at once: a one-byte difference, moving between cells, changing sign, passing in isolation every time.
 *
 * Fixing the launch flags removed most of it (see `DETERMINISTIC_LAUNCH_ARGS`, and
 * `--disable-skia-runtime-opts` above all) and was worth doing on its own. It did not remove all of it:
 * at load 10 the failures came back, and two units lost verify cycles to them after the flags landed.
 *
 * So this takes captures until two CONSECUTIVE ones agree. That preserves the claim exactly and drops the
 * part that was never true: if anything time-derived or randomly generated reached the render, no two
 * consecutive captures would ever agree, the attempts would run out, and this throws. A page that is
 * genuinely deterministic settles on the second or third.
 *
 * It cannot hide a real defect, and that is asserted rather than argued: the gate for this helper renders
 * a clock into the page and requires it to exhaust and throw.
 */
/**
 * What one capture produced: the bytes, and anything about the page the pixels cannot say.
 *
 * `note` exists because "the bytes differ" is not a diagnosis. When two captures of one page disagree, the
 * useful question is what differed about the *page*, and the thing a harness can see and a PNG cannot is
 * which requests failed. A caller that knows its page has images should put the set that failed to load in
 * here; see `captureUntilStable` for what is then said when that set changes between attempts.
 */
export interface Capture {
  readonly png: Uint8Array
  readonly note?: string
}

function pngOf(result: Uint8Array | Capture): Capture {
  return result instanceof Uint8Array ? { png: result } : result
}

/**
 * Whether a sequence of capture digests alternates between exactly two values: A B A B …
 *
 * Worth naming, because it is the signature of a page with two stable renderings rather than one that had
 * not finished painting — and no number of attempts can ever satisfy a consecutive-match rule against it,
 * so "try harder" is not the answer and neither is "this is load".
 */
function alternates(digests: readonly string[]): boolean {
  if (digests.length < 4) return false
  const distinct = new Set(digests)
  if (distinct.size !== 2) return false
  return digests.every((digest, index) => index < 2 || digest === digests[index - 2])
}

export async function captureUntilStable(
  take: () => Promise<Uint8Array | Capture>,
  options: { readonly label: string; readonly attempts?: number },
): Promise<{ readonly png: Uint8Array; readonly attemptsUsed: number }> {
  const attempts = options.attempts ?? 5
  if (attempts < 2) {
    throw new Error(
      `captureUntilStable needs at least 2 attempts to compare anything, got ${attempts}`,
    )
  }
  const sizes: number[] = []
  const digests: string[] = []
  const notes: string[] = []
  let previous: Uint8Array | null = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const capture = pngOf(await take())
    const png = capture.png
    sizes.push(png.byteLength)
    digests.push(createHash('sha256').update(png).digest('hex').slice(0, 12))
    notes.push(capture.note ?? '')
    if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(png)) === 0) {
      return { png, attemptsUsed: attempt }
    }
    previous = png
  }

  /*
   * The failure message has to say WHICH failure this is, because the three have different causes and only
   * one of them is the page's own rendering.
   *
   * The first version of this asserted "a clock, a random id or an unsettled animation is reaching the
   * render — this is not load" for every case. That was wrong twice over. It is right for captures that all
   * differ, and it is actively misleading for a page that alternates between exactly two renderings: that
   * is not a clock, it is two states, and it appeared only under seven-way load — so the one thing the
   * message ruled out was the thing that exposed it.
   *
   * And when the notes differ between attempts, neither explanation applies: something outside the render
   * changed, and the note says what. An image that loads in one capture and fails in the next is the case
   * this was built for, because the settle step deliberately swallows a decode rejection (a broken frame is
   * a legitimate fixture) and so cannot tell "broken on purpose" from "broken this time".
   */
  const distinctNotes = [...new Set(notes.filter((note) => note !== ''))]
  const noteChanged = distinctNotes.length > 1
  const diagnosis = noteChanged
    ? `the page itself changed between captures, not just its pixels: ${distinctNotes
        .map((note, index) => `(${index + 1}) ${note}`)
        .join(' vs ')}. Fix that first — the render may well be deterministic given a stable page.`
    : alternates(digests)
      ? 'the captures ALTERNATE between exactly two renderings, so this page has two stable states rather ' +
        'than unfinished paint. No number of attempts can satisfy a consecutive-match rule against that. ' +
        'Look for a request that intermittently fails, a query returning rows in either order, or state ' +
        'that flips per load — and note that load can be what exposes it.'
      : 'every capture differed, which is what a clock, a fresh identifier or an unsettled animation ' +
        'reaching the render produces. This one is not load.'

  throw new Error(
    `[screenshot-never-stabilised] ${options.label}: ${attempts} captures and no two consecutive ones ` +
      `matched. Byte lengths: ${sizes.join(', ')}. Digests: ${digests.join(', ')}. ${diagnosis}`,
  )
}

export function freezePageEnvironment(nowMs: number): void {
  const globals = globalThis as unknown as PageGlobalsForHarness

  // A fixed sequence, not a constant: a page calling Math.random() twice and getting the same number
  // both times can render something that could never happen in production.
  let seed = 0x9e3779b9
  globals.Math.random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const RealDate = globals.Date
  const frozen = function FrozenDate(this: unknown, ...args: unknown[]) {
    return args.length === 0
      ? new RealDate(nowMs)
      : new (RealDate as unknown as new (...a: unknown[]) => object)(...args)
  } as unknown as DateConstructor
  frozen.now = () => nowMs
  frozen.parse = RealDate.parse
  frozen.UTC = RealDate.UTC
  // `prototype` is read-only on a function type, so it is defined rather than assigned. Without it
  // `new Date(...) instanceof Date` is false inside the page, which breaks any library that checks.
  Object.defineProperty(frozen, 'prototype', { value: RealDate.prototype, writable: false })
  globals.Date = frozen
}
