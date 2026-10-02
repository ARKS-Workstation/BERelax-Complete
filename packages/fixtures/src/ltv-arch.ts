import { dirname, normalize, relative } from 'node:path'

/**
 * The arch rule behind "an arch test asserts no forecasting, regression or projection code
 * participates in the LTV path" (R-REP-05).
 *
 * # Why this is a scan and not a type
 *
 * Every other guarantee in this unit is structural: `cohortRealisedWindow` refuses a horizon the cohort
 * has not lived, `cohortContributionRow` refuses a delivery whose cost nothing can attribute, and the
 * expression language cannot branch, loop or read a row. None of them stops the thing this rule is
 * about, because the thing this rule is about is a plausible helper rather than a wrong signature.
 * `projectedLifetimeValue(cohort, decayRate)` has the right types, computes a number, and the number
 * goes on the same screen as the realised one.
 *
 * So the rule reads the CODE of every module the LTV path reaches, and it refuses a declared table of
 * constructs. It is a declared table rather than a list of words because a word is not a defect: the
 * sentence "no extrapolation participates in this figure" is prose and `extrapolate(` is a call, and a
 * scan that could not tell them apart would have to be turned off (`stripNonCode`'s own header records
 * the colour gate flagging the sentence that explained it).
 *
 * # Why it lives in `packages/fixtures`
 *
 * It reads files, and `packages/core` may import `@berelax/shared` and nothing else — `node:fs` is
 * refused there by `core-must-be-pure` in `.dependency-cruiser.cjs`, including from a `.test.ts`, which
 * is exactly right and is why R-REP-03's KPI arch test lives in `apps/web`. `packages/fixtures` may
 * depend on both packages and does I/O, so it is where a scan over `packages/core` belongs.
 *
 * `read` is injected rather than imported here so that `ltv-arch.test.ts` can hand the closure a
 * SYNTHETIC module and require the rule to fire on it, which is the known-bad fixture (ADR 0003) — and
 * so that gate block 149 can plant a construct in a real module on the path and require the failure by
 * the rule's own name.
 *
 * # The scope, stated rather than implied
 *
 * The closure follows RELATIVE `.ts` imports from the entry modules, which keeps it inside
 * `packages/core/src` — the tree the arithmetic is in. It does not follow `@berelax/shared`, and that is
 * a bound rather than an oversight: `shared` holds `AppError` and the analytics vocabulary, it is
 * imported by every package in the build, and a rule applied to code nobody examined is how a gate
 * acquires exceptions (`check-core-purity.mjs` makes the same argument for the same tree). What it does
 * cover is every module the LTV figure's own arithmetic passes through, which is where a forecast would
 * have to be to reach the figure.
 */

/** Every rule {@link ltvArchFindings} can report, in the order it reports them. */
export const LTV_ARCH_RULES = [
  'ltv-path-closure-reaches-its-own-modules',
  'ltv-path-holds-no-forecasting-construct',
] as const

export type LtvArchRule = (typeof LTV_ARCH_RULES)[number]

export interface LtvArchFinding {
  readonly rule: LtvArchRule
  /** The module, relative to the repository root, or `''` for a finding about the closure itself. */
  readonly module: string
  readonly detail: string
}

/**
 * The modules the LTV figure's arithmetic is written in, which the closure starts from.
 *
 * `cac.ts` is on the path because `cac_payback_months` divides the acquisition cost by the cohort's own
 * realised rate, so a forecast anywhere in it reaches a figure somebody plans against just as directly.
 * `kpi-registry.ts` is reached transitively and is not an entry, because it registers every KPI in the
 * build and entering there would widen the scope to all of them — which is R-REP-03's rules function's
 * job, not this one's.
 */
export const LTV_PATH_ENTRY_MODULES: readonly string[] = Object.freeze([
  'packages/core/src/reporting/cohorts.ts',
  'packages/core/src/reporting/cac.ts',
])

/**
 * The constructs refused, each with the reason it is a forecast rather than a calculation.
 *
 * Every pattern requires CODE syntax — a call, a declaration, an operator — so that a module may
 * explain in prose why it does not forecast. That is not a convenience: this unit's whole argument has
 * to be written down somewhere, and the place it is written down is the modules the rule scans.
 */
export const FORBIDDEN_FORECAST_CONSTRUCTS: readonly {
  readonly name: string
  readonly re: RegExp
  readonly why: string
}[] = Object.freeze([
  {
    name: 'a call to something that forecasts',
    // `\b[\w$]*` and not `\b[a-z_$][\w$]*`: the first version required a character BEFORE the keyword,
    // so `extrapolateValue(` passed and only `cohortExtrapolate(` fired. The case that enumerates this
    // table found it, which is what that case is for.
    re: /\b[\w$]*(forecast|extrapolat|projection|projected|predict|regress|annualis|annualiz)[\w$]*\s*\(/i,
    why:
      'a function that forecasts, extrapolates, projects, predicts, regresses or annualises turns an ' +
      'observation into a number about a future, and nothing about the number says which part was ' +
      'observed',
  },
  {
    name: 'a declaration naming a forecast, a curve or a rate applied forward',
    re: /\b(?:const|let|var|function|class|interface|type|enum)\s+[\w$]*(forecast|extrapolat|projection|predict|regress|decay|churn|annualis|annualiz|trend|survival|lifetimevalue)[\w$]*\b/i,
    why:
      'a retention curve, a decay, a churn rate or a survival function is the arithmetic that turns six ' +
      'weeks of history into a lifetime, and it is refused by name rather than reviewed',
  },
  {
    name: 'a rate identifier applied forward',
    re: /\b[\w$]*(?:growthRate|decayRate|churnRate|retentionRate|discountRate|survivalRate|monthlyMultiplier)[\w$]*\b/,
    why:
      'a rate is how a realised figure becomes a projected one in one multiplication, and the ' +
      'multiplication is invisible in the figure it produces',
  },
  {
    name: 'floating-point curve arithmetic',
    re: /\bMath\s*\.\s*(?:exp|pow|log|log2|log10|sqrt)\s*\(/,
    why:
      'compounding and curve fitting are what a retention model is made of, and they need a FLOAT: a ' +
      'rate below one is not a bigint, so the only way a compounding projection enters a module whose ' +
      'every figure is an exact rational of bigints is through one of these',
  },
  {
    name: 'an import of a forecasting module',
    re: /^\s*import\b[^\n]*\b(forecast|predict|regression|projection|extrapolat)/im,
    why:
      'a forecast reached through an import is on the path exactly as much as one written in place, ' +
      'and the closure is walked precisely so it cannot hide one module away',
  },
])

/**
 * `source` with comments blanked, so prose explaining a rule is not a violation of it.
 *
 * Exported so the test can assert it in both directions. It deliberately does NOT blank string
 * contents, unlike `scripts/lib/strip-non-code.mjs`'s purity mode: a forbidden construct spelled inside
 * a string is a construct somebody is about to `eval`, build a query out of or print as a formula, and
 * none of those should pass. Newlines are preserved so a reported line still points at the file.
 *
 * It duplicates what that script already does, and the reason is a boundary rather than an oversight:
 * `scripts/` is outside the root `tsconfig.json`'s `include`, nothing in `packages/` imports from it,
 * and teaching the build to is a wider decision than one unit should take. What makes the duplication
 * safe rather than a second statement that drifts is that this one's job is asserted in both
 * directions — the prose case requires it to blank a comment holding every forbidden construct, and
 * the pattern-table case requires it to leave the same constructs alone in code.
 */
export function codeOnly(source: string): string {
  const out = source.split('')
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < out.length; at += 1) {
      if (out[at] !== '\n') out[at] = ' '
    }
  }
  let at = 0
  while (at < source.length) {
    if (source.startsWith('//', at)) {
      const end = source.indexOf('\n', at)
      const stop = end === -1 ? source.length : end
      blank(at, stop)
      at = stop
      continue
    }
    if (source.startsWith('/*', at)) {
      const end = source.indexOf('*/', at + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(at, stop)
      at = stop
      continue
    }
    at += 1
  }
  return out.join('')
}

/** Every relative `.ts` import in a module, as written. */
const relativeImportsOf = (code: string): readonly string[] => {
  const found: string[] = []
  const pattern = /\bfrom\s+'(\.{1,2}\/[^']+\.ts)'/g
  let match = pattern.exec(code)
  while (match !== null) {
    const specifier = match[1]
    if (specifier !== undefined && !found.includes(specifier)) found.push(specifier)
    match = pattern.exec(code)
  }
  return found
}

/**
 * Every module reachable from `entries` by relative `.ts` imports, sorted, with `entries` first.
 *
 * A module that cannot be read is SKIPPED rather than reported, because the thing worth reporting is an
 * empty closure — `ltv-path-closure-reaches-its-own-modules` — and an unreadable entry produces one.
 * A rule that fired per missing file would turn a moved module into a dozen findings naming none of
 * them.
 */
export function ltvPathClosure(args: {
  readonly entries?: readonly string[]
  readonly read: (modulePath: string) => string | null
}): readonly string[] {
  const entries = args.entries ?? LTV_PATH_ENTRY_MODULES
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const modulePath = queue.shift()
    if (modulePath === undefined || seen.has(modulePath)) continue
    const source = args.read(modulePath)
    if (source === null) continue
    seen.add(modulePath)
    for (const specifier of relativeImportsOf(codeOnly(source))) {
      // `relative('.', ...)` keeps the path repository-relative, which is what `read` is given and what
      // a finding prints. `normalize` collapses the `../` so two routes to one module are one entry.
      queue.push(relative('.', normalize(`${dirname(modulePath)}/${specifier}`)))
    }
  }
  return Object.freeze([...seen].sort())
}

/**
 * Every forecasting construct on the LTV path, as named findings in {@link LTV_ARCH_RULES} order.
 *
 * Findings and not a throw, for `kpiRegistryFindings`' reason: a caller that wants all of them — a
 * test, a gate — gets all of them, and a rule that has stopped matching reports nothing rather than
 * passing silently. The closure is reported first, because an empty one makes every other rule vacuous.
 */
export function ltvArchFindings(args: {
  readonly entries?: readonly string[]
  readonly read: (modulePath: string) => string | null
  /** The modules the closure must reach, so a renamed import is a finding and not a smaller scan. */
  readonly mustReach?: readonly string[]
}): readonly LtvArchFinding[] {
  const entries = args.entries ?? LTV_PATH_ENTRY_MODULES
  const closure = ltvPathClosure({ entries, read: args.read })
  const findings: LtvArchFinding[] = []

  const unreached = [...entries, ...(args.mustReach ?? [])].filter(
    (modulePath) => !closure.includes(modulePath),
  )
  if (closure.length === 0 || unreached.length > 0) {
    findings.push({
      rule: 'ltv-path-closure-reaches-its-own-modules',
      module: '',
      detail:
        `the LTV path closure holds ${closure.length} module(s) and does not reach ` +
        `[${unreached.join(', ')}]. A scan over a closure that has stopped following its imports ` +
        'reports nothing and passes, which is the one way this rule can be green and dead',
    })
  }

  for (const modulePath of closure) {
    const source = args.read(modulePath)
    if (source === null) continue
    const code = codeOnly(source)
    for (const construct of FORBIDDEN_FORECAST_CONSTRUCTS) {
      const match = construct.re.exec(code)
      if (match === null) continue
      findings.push({
        rule: 'ltv-path-holds-no-forecasting-construct',
        module: modulePath,
        detail:
          `${modulePath} holds ${construct.name} ("${match[0].trim()}"), which is on the path a ` +
          `realised cohort figure is computed through: ${construct.why}`,
      })
    }
  }
  return Object.freeze(findings)
}
