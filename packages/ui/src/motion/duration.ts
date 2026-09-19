/**
 * Distance–duration: how long a movement takes is a function of how far it goes.
 *
 * docs/08 §5 states the law as `duration = clamp(120ms, 120ms + 0.6 × distance_px, 480ms)`. It is an
 * **affine** law with a floor and a ceiling, and each of the three parts is doing a different job:
 *
 * - **The floor, 120ms.** Below roughly a tenth of a second a transition is not perceived as movement
 *   at all — the eye sees two states and no path between them, which is exactly what an animation is
 *   for. An 8px chevron therefore still gets 125ms rather than the 5ms a proportional law would give
 *   it.
 * - **The slope, 0.6ms per pixel.** Duration grows with distance but *sub-proportionally*, so apparent
 *   velocity rises with the length of the travel — 0.56px/ms at 100px, 1.11px/ms at 400px, approaching
 *   1/0.6 = 1.67px/ms from below for as long as the affine part is in force. That is how the eye reads
 *   movement: a long travel at a short travel's speed feels slow, and a short travel at a long travel's
 *   speed feels like a twitch. A single duration for everything — the thing this rule exists to reject —
 *   makes velocity grow *linearly and without limit*: at a flat 320ms a 900px sheet crosses the screen
 *   at 2.8px/ms and appears to teleport, while an 8px nudge over the same 320ms reads as sluggish drift.
 * - **The ceiling, 480ms.** Past about half a second an interface stops feeling like it is responding
 *   and starts feeling like it is deciding. A full-height sheet on a tall phone would otherwise ask for
 *   660ms. Beyond 600px the ceiling is what is in force, so velocity goes on rising — the trade is
 *   deliberate: a bounded wait matters more at that size than a bounded speed.
 *
 * Why not proportional (no intercept)? Because then duration goes to zero with distance, and the
 * smallest, commonest motions — a press, a checkbox, a focus ring — are the ones that disappear.
 * Why not a curve (√distance, say)? Because the clamp already supplies the compression at both ends,
 * and a two-parameter law that a reviewer can verify by arithmetic is worth more than a third
 * parameter nobody can defend.
 *
 * Pure, and deliberately in its own module: `packages/ui/src/motion/tokens.css` cannot compute, so
 * anything that animates a *measured* distance — a sheet the height of the viewport, a drag that ends
 * where the thumb left it — reads its duration from here and sets it inline.
 */

/** The floor, in milliseconds. Below this the eye sees a jump rather than a movement. */
export const DURATION_FLOOR_MS = 120

/** The ceiling, in milliseconds. Past this an interface feels like it is deciding, not responding. */
export const DURATION_CEILING_MS = 480

/** Milliseconds per pixel: the slope of the affine part, and the ceiling on apparent velocity under it. */
export const DURATION_PER_PIXEL_MS = 0.6

/**
 * Distance-aware duration, in whole milliseconds.
 *
 * The four worked examples in docs/08 §5: 8px → 125ms, 100px → 180ms, 400px → 360ms, 900px → 480ms.
 *
 * The **magnitude** of the distance, which is the RTL invariant: an inline offset is multiplied by
 * `--dir`, so the Arabic document computes -32px where the English one computes 32px, and one animation
 * mirrored into two directions must not take two different times. Clamping a negative to the floor —
 * which is what this did before W-SYS-04 — gave the Arabic page 120ms where the English page took 139ms
 * from the same authored distance, with nothing in the CSS to explain it.
 */
export function durationForDistance(distancePx: number): number {
  const linear = DURATION_FLOOR_MS + DURATION_PER_PIXEL_MS * Math.abs(distancePx)
  return Math.round(Math.min(DURATION_CEILING_MS, Math.max(DURATION_FLOOR_MS, linear)))
}

/**
 * The same duration as a CSS time, for an inline style.
 *
 * A component that measures a distance at runtime cannot express it as a token, so it writes
 * `style={{ '--dur-move': cssDurationForDistance(distance) }}` and the stylesheet uses that. The
 * reduced-motion override still wins where it applies, because movement distances collapse to `0px`
 * and a duration applied to a motion that covers no ground is not motion.
 */
export function cssDurationForDistance(distancePx: number): string {
  return `${durationForDistance(distancePx)}ms`
}
