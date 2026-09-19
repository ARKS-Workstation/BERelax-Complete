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
