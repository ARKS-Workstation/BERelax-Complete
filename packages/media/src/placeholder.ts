/**
 * The low-quality image placeholder: one flat OKLCH colour, and no blurhash.
 *
 * docs/08 §6 states the decision plainly — a blurhash is ~30 bytes of payload plus a decoder plus a
 * canvas paint per image, and what it buys is a smear of the photograph. A flat calm colour suits this
 * aesthetic better, costs nothing to decode, and cannot flash a dark blob before the image lands. The
 * absence of blurhash is gated (`scripts/check-media.mjs`, `[no-blurhash]`) rather than merely
 * documented, because "we decided not to" is exactly the kind of decision a dependency reverses.
 *
 * OKLCH and not hex, because the band this value has to sit inside is a perceptual one. The site is
 * pastel: a placeholder has to be light enough that the swap to the photograph is not a flash, and
 * desaturated enough that it does not tint the page. "Light and desaturated" is one lightness bound
 * and one chroma bound in OKLCH; in sRGB it is neither expressible nor checkable.
 *
 * Pure arithmetic. The `sharp().stats()` call that measures the dominant colour lives in
 * `derivatives.ts`; this module takes the numbers.
 */
import { AppError } from '@berelax/shared'

/**
 * The band, from docs/08 §6.
 *
 * Not a preference. Below 0.86 the placeholder reads as a grey card and the swap to the photograph is
 * a visible flash; above 0.94 it is white and there is no placeholder at all. Chroma above 0.06 tints
 * the surrounding page, which on a pastel ground is immediately visible.
 */
export const PLACEHOLDER_CHROMA_MAX = 0.06
export const PLACEHOLDER_LIGHTNESS_MIN = 0.86
export const PLACEHOLDER_LIGHTNESS_MAX = 0.94

export interface Oklch {
  /** Perceptual lightness, 0..1. */
  readonly lightness: number
  /** Chroma. Unbounded in principle; ~0.37 is the most saturated sRGB can reach. */
  readonly chroma: number
  /** Hue angle in degrees, 0..360. */
  readonly hue: number
}

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export interface Placeholder extends Oklch {
  /**
   * The dominant colour as measured, before the band was applied.
   *
   * Kept, and not discarded, because the clamp is the interesting number. Every one of the twelve
   * fixture photographs measures *below* the lightness floor — the prototype's photography is not
   * pastel, whatever docs/08 §8 assumes — and a placeholder pipeline that silently moved them all into
   * the band would present that as a measurement. See `packages/fixtures/src/media-derivatives.itest.ts`.
   */
  readonly measured: Oklch
  /** Whether the band moved the measured colour. False means the photograph was already in band. */
  readonly clamped: boolean
}

/**
 * The CSS function name, as a constant.
 *
 * `pnpm colours` rejects a literal `oklch(...)` anywhere outside the token layer, and it is right to:
 * a hand-typed colour is one nobody derived and nobody measured. This one is derived from the
 * photograph at build time, so the name is spelled as a value and the gate reads the template for what
 * it is rather than for a colour somebody chose.
 */
const CSS_FUNCTION = 'oklch'

/** sRGB 0..255 to linear-light 0..1. */
function toLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * sRGB to OKLCH, via Ottosson's OKLab matrices.
 *
 * Written out rather than pulled from a colour library: it is eighteen coefficients that will never
 * change, and `placeholder.test.ts` pins them against the published reference values for red, white
 * and mid-grey. A dependency here would be a dependency, a version range and a supply chain for
 * arithmetic that is already settled.
 */
export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  for (const [name, value] of [
    ['r', r],
    ['g', g],
    ['b', b],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 255) {
      throw new AppError(
        'validation',
        `[placeholder-channel-out-of-range] ${name}=${value} is not an sRGB channel in 0..255`,
        { details: { r, g, b } },
      )
    }
  }

  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)

  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  const chroma = Math.hypot(a, bb)
  // `atan2` returns -180..180; a hue angle is 0..360, and a negative one in a CSS value is legal but
  // reads as a bug every time somebody looks at it.
  const hue = chroma === 0 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360

  return { lightness, chroma, hue }
}

/** Whether an OKLCH value already sits inside the placeholder band. */
export function isWithinPlaceholderBand(colour: Oklch): boolean {
  return (
    colour.chroma <= PLACEHOLDER_CHROMA_MAX &&
    colour.lightness >= PLACEHOLDER_LIGHTNESS_MIN &&
    colour.lightness <= PLACEHOLDER_LIGHTNESS_MAX
  )
}

/**
 * The placeholder for a measured dominant colour.
 *
 * The hue survives untouched — it is the only part of the measurement that carries the photograph's
 * character, and a clamp that also rotated it would produce a colour with no relationship to the
 * image. Lightness and chroma are pulled into the band, and `clamped` records that it happened so the
 * caller can report it rather than discover it.
 */
export function placeholderFor(dominant: Rgb): Placeholder {
  const measured = rgbToOklch(dominant)
  const lightness = Math.min(
    Math.max(measured.lightness, PLACEHOLDER_LIGHTNESS_MIN),
    PLACEHOLDER_LIGHTNESS_MAX,
  )
  const chroma = Math.min(measured.chroma, PLACEHOLDER_CHROMA_MAX)
  return {
    lightness,
    chroma,
    hue: measured.hue,
    measured,
    clamped: lightness !== measured.lightness || chroma !== measured.chroma,
  }
}

/** The placeholder as a CSS colour, for an inline `background-color` while the image loads. */
export function placeholderCss(colour: Oklch): string {
  const lightness = `${(colour.lightness * 100).toFixed(2)}%`
  return `${CSS_FUNCTION}(${lightness} ${colour.chroma.toFixed(4)} ${colour.hue.toFixed(2)})`
}
