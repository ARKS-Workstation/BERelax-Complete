/**
 * The home route's performance budget: five numbers from docs/08 §8, and the judgement that fails on them.
 *
 * ## Why the numbers are here and not in `build/budgets.json`
 *
 * `build/budgets.json` measures artefacts a script can weigh without a browser — a file on disk, a font
 * subset, a derivative built through the real encoder, a chunk the build wrote. Three of the five numbers
 * below cannot be answered that way, and not for want of trying:
 *
 *   - **requests before LCP** is a claim about an ordering of network events against a
 *     `largest-contentful-paint` entry. There is no such ordering in a build directory.
 *   - **DOM nodes** is a count of the rendered document, and this page's document is rendered from the
 *     database. A count taken off the HTML a build happened to prerender would not survive a revalidation.
 *   - **critical above-fold** is the sum of what a browser downloaded before LCP at a stated viewport. The
 *     rungs of an art-directed image differ between 390px and 1440px, so it is not a property of the build.
 *
 * The other two — first-party JS and CSS — *could* be read out of the build, and splitting the five across
 * two mechanisms would be worse than either: a budget is a set of numbers that either all hold or do not,
 * and one half failing in `pnpm budgets` while the other half failed in `pnpm test:integration` is a
 * reader's problem for no gain. So all five are declared here, measured in a real browser against a real
 * `next start` by `apps/web/src/home.itest.ts`, and judged by {@link judgeHomeBudget}, which is pure and
 * has its own unit test with an oversized fixture.
 *
 * Both steps are in `pnpm verify` and in CI, so a breach is a red build either way — which is what docs/08
 * §8's second enforcement layer asks for ("CI — … that **fails the build** on home, service, therapist and
 * gallery routes, in both themes and both directions").
 *
 * ## Why every finding carries the measured value
 *
 * `scripts/check-budgets.mjs` records the reason and it is the same one: *"the first question anybody asks
 * of a breached budget is by how much"*. A failure that says "over budget" sends somebody to build the page
 * twice to find out; a failure that says `measured 118,784 bytes against 112,640` is already the diagnosis.
 */

/** Which of the five a finding is about. Named, so a failure is greppable and a fix is scoped. */
export const HOME_BUDGET_METRICS = [
  'first-party-js',
  'css',
  'critical-above-fold',
  'requests-before-lcp',
  'dom-nodes',
] as const

export type HomeBudgetMetric = (typeof HOME_BUDGET_METRICS)[number]

/** A kibibyte, so the numbers below read as the kilobytes docs/08 §8 writes. */
const KIB = 1024

export interface HomeBudgetLimit {
  readonly metric: HomeBudgetMetric
  readonly limit: number
  /** `bytes` prints as KB in a failure; `count` prints as a bare number. */
  readonly unit: 'bytes' | 'count'
  readonly why: string
}

/**
 * docs/08 §8's home-route row, as five limits.
 *
 * The three byte figures are the table's kilobytes times 1024, which is the same basis every entry in
 * `build/budgets.json` uses — `hero-video-desktop` records it ("1.2 × 1048576 rounded, matching the KiB
 * basis of every other budget in this file"). Mixing KB and KiB across two budget files would make a page
 * pass one and fail the other by 2.4%.
 */
export const HOME_BUDGET: readonly HomeBudgetLimit[] = [
  {
    metric: 'first-party-js',
    limit: 110 * KIB,
    unit: 'bytes',
    why:
      'docs/08 §8: "First-party JS, home route ≤110KB gzip". **This application\'s own** client ' +
      'JavaScript: every script the document loads that .next/build-manifest.json does not declare in ' +
      'rootMainFiles or polyfillFiles. That exclusion is the build’s own boundary rather than a ' +
      'judgement, and it is not a way of making the number smaller: home.itest.ts measures the framework ' +
      'baseline separately, asserts the two halves add up to every script byte the document loads, and ' +
      'prints the floor — because a baseline nothing measures is how 129KB comes to be nobody’s. ' +
      'This half is the one a page controls, and it is the number that moves when a library arrives ' +
      'anywhere in the route’s client graph — the failure docs/08 §7 puts the motion library ' +
      'behind two code-split islands to prevent, at 32-36KB gzip apiece.',
  },
  {
    metric: 'css',
    limit: 25 * KIB,
    unit: 'bytes',
    why:
      'docs/08 §8: "CSS ≤25KB gzip (expect 14-18KB)". Every stylesheet the document links plus every ' +
      '<style> element it inlines, because this design system ships its component CSS in hoisted <style> ' +
      'elements (packages/ui/src/layout/styles.tsx says why) — counting linked files alone would measure ' +
      'the smaller half and call it the total. The linked half is the browser’s own encoded size and is ' +
      'therefore already compressed; the inline half travels inside the gzipped document, so it is ' +
      'compressed at level 9 on the Node side, the basis every entry in build/budgets.json uses. Measuring ' +
      'it raw counted 22KB of design-system CSS against a 25KB *gzip* limit and reported the page over, ' +
      'which is an uncompressed number compared with a compressed one rather than a measurement.',
  },
  {
    metric: 'critical-above-fold',
    limit: 250 * KIB,
    unit: 'bytes',
    why:
      'docs/08 §8: "Critical above-fold ≤250KB" on mobile. Measured at 390px as the encoded bytes of the ' +
      'document plus the encoded bytes of every resource on its critical path — the render-blocking ' +
      'ones, the ones the head preloads, and the LCP element’s own. The hero poster is most of it, at ' +
      'docs/08 §8’s ≤95KB AVIF, and the two font files are most of the rest. See ' +
      'requests-before-lcp for why the set is derived from the document rather than from timings.',
  },
  {
    metric: 'requests-before-lcp',
    limit: 8,
    unit: 'count',
    why:
      'docs/08 §8: "Requests before LCP ≤8" on mobile. The document, every render-blocking resource, ' +
      'every resource the head preloads, and the LCP element’s own — the requests the document ' +
      'PUTS on the path to its largest paint. Derived from the markup and not from timings, and the ' +
      'difference was measured rather than reasoned: on this page the framework’s async chunks ' +
      'finish within twenty milliseconds of the LCP entry, so "requests that started before it" counts ' +
      'fifteen and "requests that finished before it" counts seven on the same page, and which of the two ' +
      'a run reported would depend on how loaded the machine was. A budget that answers differently on a ' +
      'busy machine is not a budget. It is the number the same-origin media rule exists to protect ' +
      '(packages/media/src/storage/port.ts: a Spaces hostname costs DNS, TCP and TLS before the first ' +
      'byte of the LCP image) and the number a third-party font host would break on its own.',
  },
  {
    metric: 'dom-nodes',
    limit: 1500,
    unit: 'count',
    why:
      'docs/08 §8: "DOM nodes ≤1500". This page renders one card per published treatment and one per ' +
      'therapist on the roster, so it is the one budget that grows with the business rather than with the ' +
      'code — which is exactly why it is a number in CI and not a review comment.',
  },
]

/** One measurement per metric. Total over the union, so a new limit cannot be left unmeasured. */
export type HomeBudgetMeasurement = Readonly<Record<HomeBudgetMetric, number>>

export interface HomeBudgetFinding {
  readonly metric: HomeBudgetMetric
  readonly measured: number
  readonly limit: number
  /** The sentence a failing assertion prints. Carries both numbers; see the header. */
  readonly message: string
}

const kb = (bytes: number): string => `${(bytes / KIB).toFixed(1)}KB`

function describe(limit: HomeBudgetLimit, measured: number): string {
  const shown =
    limit.unit === 'bytes'
      ? `${kb(measured)} (${measured} bytes) against a budget of ${kb(limit.limit)} (${limit.limit} bytes)`
      : `${measured} against a budget of ${limit.limit}`
  return `[home-budget-over] ${limit.metric}: measured ${shown}. ${limit.why}`
}

/**
 * Every limit the measurement breaches, with the measured value.
 *
 * Findings rather than a throw, so a run reports all five rather than the first — the same reason
 * `overlappingBands()` in `@berelax/harness/ports` returns a list. A page that is over on JS and over on
 * requests has two things to fix, and being told about one of them costs a second build.
 *
 * `>` and not `>=`: a page exactly at the budget is inside it. docs/08 §8 writes "≤".
 *
 * `limits` is a parameter and defaults to {@link HOME_BUDGET}, which is how the acceptance's *"an oversized
 * fixture proves the budget fires"* is satisfied against the **real** page rather than against a synthetic
 * number. `apps/web/src/home.itest.ts` measures the running application, asserts it is inside the real
 * limits, and then re-judges the *same measurement* against lowered ones — so the failure it proves carries
 * the bytes and nodes the page actually has. Feeding a made-up measurement to the real limits would prove
 * the arithmetic and not the wiring, and the wiring is what silently stops working.
 */
export function judgeHomeBudget(
  measured: HomeBudgetMeasurement,
  limits: readonly HomeBudgetLimit[] = HOME_BUDGET,
): readonly HomeBudgetFinding[] {
  const findings: HomeBudgetFinding[] = []
  for (const limit of limits) {
    const value = measured[limit.metric]
    if (value <= limit.limit) continue
    findings.push({
      metric: limit.metric,
      measured: value,
      limit: limit.limit,
      message: describe(limit, value),
    })
  }
  return findings
}

/** The findings as one printable block, or the empty string. What an assertion compares against ''. */
export function formatHomeBudgetFindings(findings: readonly HomeBudgetFinding[]): string {
  return findings.map((finding) => finding.message).join('\n')
}

/** The limit for one metric. Throws for a metric the table does not declare, which cannot be typed away. */
export function homeBudgetLimit(metric: HomeBudgetMetric): number {
  const limit = HOME_BUDGET.find((entry) => entry.metric === metric)
  if (limit === undefined) throw new Error(`no home budget declared for '${metric}'`)
  return limit.limit
}
