/**
 * `/book`'s performance budget: the two numbers docs/09 §3 measures, and the judgement that fails on them.
 *
 * docs/09 §3's *"Measure"* line names four things and two of them are budgets with a number:
 * *"INP on `/book` specifically"* and *"time to first slot rendered"*. B-UI-02's acceptance puts a figure
 * on each — INP under 200 ms, first slot rendered under 1 s — and asks that *"the job fails when either
 * budget is breached"*.
 *
 * ## Why the numbers are here and not in `build/budgets.json`
 *
 * `scripts/check-budgets.mjs` weighs artefacts: a file on disk, a font subset, a derivative built through
 * the real encoder, a chunk the build wrote. Neither number below is an artefact. **INP** is the time from
 * an interaction to the next paint, which exists only in a browser with a real event loop; **time to first
 * slot rendered** is a paint timestamp on a page whose content comes from the availability engine. The
 * home route made the same split for the same reason and `apps/web/src/home/budget.ts` records it; this
 * file is that arrangement for the one route docs/09 names by itself.
 *
 * ## Why there is no Lighthouse CI here
 *
 * The acceptance line says *"Lighthouse CI on /book"*, and there is no Lighthouse in this repository.
 * W-SITE-11 owns it — `lighthouse/budget.json` and `lighthouserc.cjs` are in that unit's files list, and
 * `pnpm verify` has no step that could run it. W-SITE-04 recorded exactly this deferral for the home
 * route's five numbers, and adding a second budget mechanism for one route would leave the same page
 * measured twice in two places with two sets of numbers to keep in step. So the budget is declared here,
 * measured in a real browser against a real `next start` by `apps/web/src/book-flow.itest.ts`, and
 * `pnpm test:integration` is the job that fails — which is in `pnpm verify` and in CI.
 *
 * ## Why the third metric is here when the acceptance names two
 *
 * `first-party-js`, because docs/09 §3 also says *"the booking flow is the **one** heavy client island"*.
 * A page that is allowed one island and has no number on it is a page where the island grows: this route's
 * island now carries the slot grid's keyboard behaviour AND the details step's, and the most expensive
 * mistake available in a client component is an import that drags a server-side library across the
 * boundary. docs/08 §8 budgets first-party JS at 110KB gzip for the home route; the same figure is used
 * here, and the reason it is the same rather than larger is that the home route is the one with a video
 * hero and a motion library, so a booking form has no claim to more.
 */

/** Which of the three a finding is about. Named, so a failure is greppable and a fix is scoped. */
export const BOOK_BUDGET_METRICS = ['inp', 'time-to-first-slot', 'first-party-js'] as const

export type BookBudgetMetric = (typeof BOOK_BUDGET_METRICS)[number]

/** A kibibyte, so the byte figure reads as the kilobytes docs/08 §8 writes. */
const KIB = 1024

export interface BookBudgetLimit {
  readonly metric: BookBudgetMetric
  readonly limit: number
  /** `ms` prints as milliseconds, `bytes` as KB. */
  readonly unit: 'ms' | 'bytes'
  readonly why: string
}

export const BOOK_BUDGET: readonly BookBudgetLimit[] = [
  {
    metric: 'inp',
    limit: 200,
    unit: 'ms',
    why:
      'B-UI-02 acceptance: "INP under 200 ms". Measured as the worst interaction-to-next-paint over the ' +
      'slot picker — a pointer press on a time, and an arrow key across the grid — because those are the ' +
      'only interactions on the route that run first-party JavaScript. docs/08 §8 targets 150ms in the ' +
      'field on a mid-tier Android and Google calls 200ms "good"; the acceptance line names 200 and that ' +
      'is what is enforced here, because a lab number on a four-core container is not the p75 field ' +
      'number and pretending otherwise would make the stricter figure a flake rather than a budget. ' +
      "docs/09 §3 also asks for the slot picker's click-to-paint to stay under 100ms, which this bounds.",
  },
  {
    metric: 'time-to-first-slot',
    limit: 1000,
    unit: 'ms',
    why:
      'B-UI-02 acceptance: "time-to-first-slot-rendered under 1 s". Measured from the navigation start to ' +
      'the paint that contains the first `[role="option"]`, on a URL that names a treatment, a client and ' +
      'a day — the state in which there ARE slots. It is a server-render number on this route by design: ' +
      'the slot list is in the initial HTML (B-UI-01), so what this measures is the availability read plus ' +
      'the response, and it is the number that moves when somebody adds a query to the page. A bare /book ' +
      'renders no slot list at all and is not a candidate: strict same-gender matching refuses before a ' +
      'client is stated, so timing it would be timing a named state.',
  },
  {
    metric: 'first-party-js',
    limit: 110 * KIB,
    unit: 'bytes',
    why:
      'docs/08 §8 budgets first-party JS at 110KB gzip, and docs/09 §3 allows this route the one heavy ' +
      'island. Measured the way home.itest.ts measures it: every script the document loads that ' +
      '.next/build-manifest.json does not declare as a framework baseline. The failure it exists to catch ' +
      'is an import in a client component that drags a server-side graph across the boundary — the ' +
      'booking flow normalises a phone number on blur through the one normaliser in @berelax/core, and ' +
      'that barrel reaches a zod schema two hops away.',
  },
]

/** One measurement per metric. Total over the union, so a new limit cannot be left unmeasured. */
export type BookBudgetMeasurement = Readonly<Record<BookBudgetMetric, number>>

export interface BookBudgetFinding {
  readonly metric: BookBudgetMetric
  readonly measured: number
  readonly limit: number
  /** The sentence a failing assertion prints. Carries both numbers. */
  readonly message: string
}

const kb = (bytes: number): string => `${(bytes / KIB).toFixed(1)}KB`

function describe(limit: BookBudgetLimit, measured: number): string {
  const shown =
    limit.unit === 'bytes'
      ? `${kb(measured)} (${measured} bytes) against a budget of ${kb(limit.limit)} (${limit.limit} bytes)`
      : `${Math.round(measured)}ms against a budget of ${limit.limit}ms`
  return `[book-budget-over] ${limit.metric}: measured ${shown}. ${limit.why}`
}

/**
 * Every limit the measurement breaches, with the measured value.
 *
 * Findings rather than a throw, so a run reports all three rather than the first — the same reason
 * `overlappingBands()` in `@berelax/harness/ports` returns a list.
 *
 * `>` and not `>=`: a page exactly at the budget is inside it. The acceptance writes "under", and one
 * millisecond of difference between "under 200" and "at most 200" is not a distinction a lab measurement
 * on a loaded container can resolve — so the looser reading is taken deliberately rather than by accident.
 *
 * `limits` is a parameter and defaults to {@link BOOK_BUDGET}, which is how *"the job fails when either
 * budget is breached"* is proved against the **real** page rather than against a synthetic number:
 * `book-flow.itest.ts` measures the running application, asserts it is inside the real limits, and then
 * re-judges the *same measurement* against lowered ones. Feeding a made-up measurement to the real limits
 * would prove the arithmetic and not the wiring, and the wiring is what silently stops working.
 */
export function judgeBookBudget(
  measured: BookBudgetMeasurement,
  limits: readonly BookBudgetLimit[] = BOOK_BUDGET,
): readonly BookBudgetFinding[] {
  const findings: BookBudgetFinding[] = []
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
export function formatBookBudgetFindings(findings: readonly BookBudgetFinding[]): string {
  return findings.map((finding) => finding.message).join('\n')
}

/** The limit for one metric. Throws for a metric the table does not declare, which cannot be typed away. */
export function bookBudgetLimit(metric: BookBudgetMetric): number {
  const limit = BOOK_BUDGET.find((entry) => entry.metric === metric)
  if (limit === undefined) throw new Error(`no book budget declared for '${metric}'`)
  return limit.limit
}
