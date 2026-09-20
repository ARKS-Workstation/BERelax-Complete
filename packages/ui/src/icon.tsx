/**
 * The icon wrapper: the one module in this repository that may import Lucide.
 *
 * ## Why a wrapper, and why a dependency-cruiser rule around it
 *
 * docs/08 §7 asks for Lucide "behind a wrapped `<Icon>` export at `strokeWidth 1.5`, 20px UI / 24px
 * nav". Imported directly, each of those three numbers is a prop somebody has to remember at every
 * call site, and the ones they forget are Lucide's defaults: stroke 2 at 24px, which is a heavier,
 * geometrically different system sitting beside 17px humanist text. `no-lucide-outside-the-icon-wrapper`
 * in `.dependency-cruiser.cjs` is what keeps that from being a convention — it fails the build, and
 * `scripts/test-gates.mjs` writes a file that imports Lucide from `packages/ui/src/primitives` to prove
 * the rule fires.
 *
 * The second thing the wrapper buys is a **closed set of names**. `IconName` is a union of what this
 * interface actually draws, so an icon nobody chose does not compile, and the bundle carries eight
 * glyphs rather than the whole library.
 *
 * ## `aria-hidden`, always
 *
 * An icon is never the accessible name. It is drawn beside text, or inside a control whose
 * `aria-label` says what the control does — which is the rule `IconLabelling` in `primitives/contract.ts`
 * makes a compile error to break. So every glyph is hidden from the accessibility tree and no icon here
 * takes a `title`: a tooltip on an SVG is a name that only a mouse can reach.
 */
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  Clock,
  Pause,
  Phone,
  Play,
  Search,
  X,
} from 'lucide-react'
import { ICON_SIZE, ICON_STROKE_WIDTH, type IconPlacement } from './primitives/contract.ts'

/**
 * The glyphs this interface draws.
 *
 * Named for what they mean here rather than for Lucide's file names, because the call sites read as
 * intent — `name="back"` survives a swap of the drawing, `name="chevron-left"` does not.
 */
const GLYPHS = {
  calendar: Calendar,
  check: Check,
  chevron: ChevronDown,
  back: ChevronLeft,
  clock: Clock,
  // The hero loop's WCAG 2.2.2 control (docs/08 §6). One control, both glyphs in the markup, and the
  // state attribute decides which is drawn — see packages/ui/src/media/pause-control.tsx.
  pause: Pause,
  play: Play,
  phone: Phone,
  search: Search,
  close: X,
} as const

export type IconName = keyof typeof GLYPHS

/** Every name, so a gallery or a test can draw the whole set rather than a sample of it. */
export const ICON_NAMES = Object.keys(GLYPHS) as readonly IconName[]

/**
 * Icons that mean a direction, and therefore mirror in Arabic.
 *
 * docs/08 §7: "icons that imply direction have to flip". `back` points at where the reader came from,
 * which is the right-hand side of an RTL page. A clock does not flip — it is not a direction, and
 * mirroring it would draw a clock that runs backwards.
 */
const MIRRORED: ReadonlySet<IconName> = new Set<IconName>(['back'])

/**
 * The mirror, as one rule rather than a second set of glyphs.
 *
 * Same mechanism as the reveal in `layout/styles.tsx`: authored once, flipped by direction. It is a
 * `transform` and not an `animation-name`, so it says nothing about motion and `pnpm layout`'s
 * `no-mirrored-keyframes-pair` has nothing to object to.
 */
export const ICON_CSS = `
.be-icon { flex: none; }

[dir="rtl"] .be-icon[data-icon-mirror="true"] { transform: scaleX(-1); }
`

export interface IconProps {
  readonly name: IconName
  /** `ui` is 20px, `nav` is 24px. docs/08 §7. There is no third size. */
  readonly placement?: IconPlacement
  readonly className?: string
}

export function Icon({ name, placement = 'ui', className }: IconProps) {
  const Glyph = GLYPHS[name]
  const size = ICON_SIZE[placement]
  return (
    <Glyph
      className={className === undefined ? 'be-icon' : `be-icon ${className}`}
      // Read back by `apps/web/src/primitives.itest.ts`, which asserts every drawn glyph is the size
      // its placement declares at the stroke width docs/08 §7 states.
      data-icon={name}
      data-icon-placement={placement}
      data-icon-mirror={MIRRORED.has(name)}
      width={size}
      height={size}
      strokeWidth={ICON_STROKE_WIDTH}
      aria-hidden="true"
      focusable="false"
    />
  )
}
