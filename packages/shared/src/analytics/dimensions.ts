/**
 * The measurement DIMENSIONS, as values with no schema: device kinds, breakpoint bands, writing
 * directions, and the shape of a web-vitals figure.
 *
 * ## Why this module exists, and what it cost to find out
 *
 * **It imports nothing.** No zod, no `AppError`, no sibling. That is the whole reason it is a module:
 * everything in it is read by code running in a BROWSER, and `collect.ts` and `taxonomy.ts` — where these
 * declarations used to live — both import zod at module scope.
 *
 * A-MEAS-04 measured the cost. Its first build put the web-vitals reporter and the tag loader in a
 * defining chunk of **106,765 bytes** against a budget that was supposed to be a couple of kilobytes,
 * because the reporter imported `parseAnalyticsEvent` and `breakpointFor` from `@berelax/shared` — and
 * the two modules behind them pull zod and every schema in the package into the chunk. It is the same
 * defect A-FIRST-06 paid 98KB for, which is why `collect-limits.ts` was already a zod-free leaf the
 * collector imports by its own subpath: this is that arrangement extended to the rest of the vocabulary
 * a browser needs.
 *
 * The declarations are MOVED rather than copied, and `collect.ts` and `taxonomy.ts` re-export them, so
 * there is exactly one statement of each and every existing caller is unaffected. A copy here would be
 * the second statement of a fact that drifts, which is the defect the taxonomy's own header is about.
 *
 * ## What may be added here, and what may not
 *
 * A value a browser needs and a schema does not. Anything that validates belongs beside its schema: this
 * module deliberately cannot refuse an input, and a `.parse` here would be the thing that reintroduced
 * the dependency it exists to keep out. `scripts/check-core-purity.mjs` reads this tree, and the import
 * list being empty is the claim — a single import of a module that imports zod undoes the whole file.
 */

/**
 * What kind of device, as `analytics.session.device_kind`'s CHECK spells it (migration 0096).
 *
 * A second statement of the constraint's four words, unavoidably: `db` may not import `core` and SQL
 * cannot import anything, so the vocabulary has to live where all three can reach it and the agreement
 * has to be asserted rather than expressed. Gate case 144 reads the migration, the Drizzle mirror and
 * this tuple and requires the same four words in all three — the arrangement A-FIRST-03 recorded for
 * `attribution_basis_known` and for the same reason.
 *
 * `unknown` is a member and not an absence, because a client that reports no viewport is the ordinary
 * case for a crawler and for a `sendBeacon` from a backgrounded tab. A nullable column would make "we
 * were not told" and "nobody has looked" the same value.
 */
export const DEVICE_KINDS = ['mobile', 'tablet', 'desktop', 'unknown'] as const
export type DeviceKind = (typeof DEVICE_KINDS)[number]

/**
 * The layout breakpoint a viewport width falls in, by name.
 *
 * The names and the widths are `BREAKPOINTS` in `@berelax/ui` — the design tokens, which are where a
 * breakpoint comes into existence (ADR 0012) — and this is a second statement of them for the reason
 * {@link DEVICE_KINDS} is: `packages/ui` is a React package that an API route has no business importing,
 * and `packages/shared` may not import it either. So the equality is a CHECK rather than a derivation:
 * `apps/web/src/breakpoint-capture.test.ts` is the only place both are reachable and holds the two equal
 * in both directions, which is the arrangement A-FIRST-04 used for the crawler table.
 *
 * `base` is the band BELOW the smallest declared breakpoint. It is named rather than left as a gap
 * because 360 is a floor and not a target — a 320px viewport is a real phone, and a device reporting one
 * must land in a named bucket rather than in whichever branch a comparison fell through to.
 */
export const ANALYTICS_BREAKPOINT_BANDS = [
  { name: 'xxl', minWidth: 1600 },
  { name: 'xl', minWidth: 1280 },
  { name: 'lg', minWidth: 1024 },
  { name: 'md', minWidth: 768 },
  { name: 'sm', minWidth: 480 },
  { name: 'xs', minWidth: 360 },
  { name: 'base', minWidth: 0 },
] as const

/** What the client did not tell us. Stored as a value, for {@link DEVICE_KINDS}'s reason. */
export const BREAKPOINT_UNKNOWN = 'unknown'

export type AnalyticsBreakpoint =
  | (typeof ANALYTICS_BREAKPOINT_BANDS)[number]['name']
  | typeof BREAKPOINT_UNKNOWN

/** Every breakpoint a session row may carry, widest first, with `unknown` last. */
export const ANALYTICS_BREAKPOINTS: readonly AnalyticsBreakpoint[] = [
  ...ANALYTICS_BREAKPOINT_BANDS.map((band) => band.name),
  BREAKPOINT_UNKNOWN,
]

/**
 * The two breakpoints the device bands are cut at, BY NAME rather than by a width written again.
 *
 * Where the line between a tablet and a desktop falls is a judgement, and it is the token layer's
 * judgement: a device that gets the desktop layout is a desktop for the purposes of a report about
 * layout. Naming the band rather than repeating 1024 means a change to the ramp moves both functions
 * together, and the drift test that holds the ramp equal to `@berelax/ui` covers both at once. Splitting
 * "device" off from "breakpoint" with thresholds of its own would give the analytics page two different
 * answers to one question.
 */
const DESKTOP_FROM_BAND = 'lg'
const TABLET_FROM_BAND = 'md'

const minWidthOf = (name: string): number | undefined =>
  ANALYTICS_BREAKPOINT_BANDS.find((band) => band.name === name)?.minWidth

/** A width the client did not report, or reported as something that cannot be a viewport. */
const unusableWidth = (viewportWidth: number | null): boolean =>
  viewportWidth === null || !Number.isFinite(viewportWidth) || viewportWidth <= 0

/** The breakpoint a width falls in, or {@link BREAKPOINT_UNKNOWN} when none was reported. */
export function breakpointFor(viewportWidth: number | null): AnalyticsBreakpoint {
  if (unusableWidth(viewportWidth)) return BREAKPOINT_UNKNOWN
  for (const band of ANALYTICS_BREAKPOINT_BANDS) {
    if ((viewportWidth as number) >= band.minWidth) return band.name
  }
  return BREAKPOINT_UNKNOWN
}

/**
 * The device kind a width falls in, or `unknown`.
 *
 * Three bands from two boundaries: below `md` is a phone, `md` up to `lg` is a tablet, `lg` and above is
 * a desktop. Both boundaries are read out of the band table, so neither number appears here.
 */
export function deviceKindFor(viewportWidth: number | null): DeviceKind {
  if (unusableWidth(viewportWidth)) return 'unknown'
  const desktopFrom = minWidthOf(DESKTOP_FROM_BAND)
  const tabletFrom = minWidthOf(TABLET_FROM_BAND)
  if (desktopFrom === undefined || tabletFrom === undefined) return 'unknown'
  const width = viewportWidth as number
  if (width >= desktopFrom) return 'desktop'
  return width >= tabletFrom ? 'tablet' : 'mobile'
}

/**
 * The field metrics A-MEAS-04 reports, by their published names.
 *
 * Google's spellings and not ours, exactly as `CONSENT_MODE_SIGNALS` carries Google's signal names: these
 * are the identifiers every other tool in this space uses, and a local spelling would make a figure
 * collected here incomparable with one measured anywhere else.
 *
 * Five and not three. The three Core Web Vitals are LCP, CLS and INP; `TTFB` and `FCP` are here because
 * they are the two that say WHERE an LCP problem is — a slow LCP with a fast TTFB is a rendering problem
 * and a slow LCP with a slow TTFB is a server problem, and without both the field data can only say that
 * the page is slow.
 */
export const WEB_VITALS_METRICS = ['LCP', 'CLS', 'INP', 'TTFB', 'FCP'] as const
export type WebVitalsMetric = (typeof WEB_VITALS_METRICS)[number]

/**
 * The writing directions, as the one statement of them in `shared`.
 *
 * `directionFor` in `@berelax/ui` produces these two and `packages/shared` may not import a React
 * package, so this is the same arrangement {@link ANALYTICS_BREAKPOINT_BANDS} records for the band names:
 * a second statement with a CHECK holding the two equal, and
 * `packages/ui/src/analytics/web-vitals.test.ts` is where both are reachable.
 */
export const ANALYTICS_WRITING_DIRECTIONS = ['ltr', 'rtl'] as const
export type AnalyticsWritingDirection = (typeof ANALYTICS_WRITING_DIRECTIONS)[number]

/**
 * The largest figure a metric may carry, and the units every metric is carried in.
 *
 * **Integers only, and never a float.** LCP, INP, TTFB and FCP are whole milliseconds; CLS is unitless
 * and is carried in THOUSANDTHS, so a layout shift of 0.082 arrives as 82. That is the same decision
 * ADR 0007 makes about money applied to a measurement: a float in a stored figure produces a rounding
 * somebody discovers in a report, and a per-mille integer and the two numbers it came from can be
 * reconciled by hand. The multiplier is applied in one place, `webVitalsValueOf`.
 *
 * The cap is one hour in milliseconds. A page a visitor left open for a day does not produce a 24-hour
 * LCP — the observer stops at the first interaction or at `visibilitychange` — so a figure past this is a
 * clock the browser cannot be trusted about, and the envelope refuses it rather than storing it.
 */
export const WEB_VITALS_MAX_VALUE = 3_600_000
export const CLS_VALUE_SCALE = 1000

/**
 * The cap on the identity of the element a metric is attributed to.
 *
 * Short on purpose. The identity is a structural path and nothing else (see
 * {@link WEB_VITALS_IDENTITY_PATTERN}), and a long one is a page with deeply nested layout rather than a
 * longer name.
 */
export const WEB_VITALS_IDENTITY_MAX = 160

/**
 * What an attribution identity may contain, as a pattern the `web_vitals` payload schema enforces.
 *
 * **This is the whole of ADR 0115 and it is the reason the pattern is a pattern and not a length cap.**
 * web-vitals v4's attribution gives the LCP element, the largest shift's sources and the INP target, and
 * the obvious way to carry one is the selector a library generates — `#price-table`,
 * `.deep-tissue-card`, or in the worst case the element's own text. Every one of those can carry a
 * service name, a price or a sentence a visitor typed, and docs/03 §6 is explicit that a name in the raw
 * payload is the thing that later gets copied into an outbound push.
 *
 * So an identity is built from THREE things and the pattern admits nothing else: lowercase tag names,
 * `:nth-of-type(N)` positions, and at most one trailing `[data-track=<event>]` naming an event the
 * taxonomy already holds. No id, no class, no attribute value the page's content could reach, no text. A
 * selector with a class in it does not merely get truncated — it is REFUSED, by the server, with the
 * event named.
 *
 * A tag name is `[a-z][a-z0-9-]*` and not `[a-z]+`, which was the first version of this pattern and was
 * wrong in the one case that matters most: `h1` to `h6` carry a digit, and a heading is the commonest LCP
 * element on a text page. It refused every heading, every `h2` identity came back null, and the symptom
 * was a metric with no attribution rather than an error. The hyphen admits a custom element's name, which
 * is structural for the same reason a tag name is: it is chosen by whoever wrote the component, never by
 * the page's content.
 */
export const WEB_VITALS_IDENTITY_PATTERN =
  /^[a-z][a-z0-9-]*(?::nth-of-type\(\d+\))?(?:>[a-z][a-z0-9-]*(?::nth-of-type\(\d+\))?)*(?:\[data-track=[a-z_]+\])?$/
