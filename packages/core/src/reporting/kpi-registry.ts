import { AppError } from '@berelax/shared'
import type { AccountCode } from '../ledger/account.ts'
import type { ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import { STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import type {
  KpiExpr,
  KpiInput,
  KpiResult,
  KpiSpec,
  KpiUnit,
  Measure,
  MeasuredKpi,
} from './kpi-expression.ts'
import {
  evaluateExpr,
  expandExpr,
  formatFigure,
  KPI_UNIT_DECIMALS,
  recordedReads,
  referencesOf,
  renderExpr,
  unitOfExpr,
} from './kpi-expression.ts'
import { REVPAR_KPIS, REVPAR_MEASURES, REVPARH_REVENUE_PARTITION } from './revpar.ts'
import { UTILISATION_KPIS, UTILISATION_MEASURES } from './utilisation.ts'

/**
 * The KPI registry: named pure functions, each carrying its formula as a string (R-REP-03).
 *
 * # The one design decision, and the hazard it closes
 *
 * "A registry of named pure KPI functions each carrying its formula as a documented string" is two
 * statements of one fact written the obvious way — a `formula` field and a body beside it — and the
 * brief's rule about a second statement applies exactly: they drift, and nothing fails, because a wrong
 * formula is still a string and the figure it misdescribes is still a figure. A dashboard then publishes
 * a definition that is not what was computed, which is worse than publishing none.
 *
 * So **the formula is derived, not written.** A KPI declares one {@link KpiExpr}; {@link buildKpiRegistry}
 * renders it to `formula` and `expandedFormula` and compiles it to `compute`. All three come from the
 * same tree, so there is nothing to hold equal — and the check that the derivation is not vacuous is
 * `kpi-formula-names-every-reference-it-computes`, which requires every name the expression reaches to
 * appear in the rendered string. A renderer that returned a constant, or that dropped the right-hand
 * side of a subtraction, fails it by name.
 *
 * What remains a second statement is a {@link Measure}'s `reads` declaration, because an aggregation is
 * a fold and cannot be an expression. That arrives with the check that holds it equal in the same
 * commit: `measure-reads-exactly-the-fields-it-declares` replays each reducer against a recording copy
 * of a probe input and compares the observed `<dataset>.<field>` accesses with the declaration, in both
 * directions. The direction that earns it is "declared and not read": it is what fires when the
 * available-room-hours denominator stops reading `dim_date.open_minutes` and starts assuming the 15
 * hours that are correct today.
 *
 * # Why the rules are findings over an ARGUMENT
 *
 * {@link kpiRegistryFindings} returns named findings rather than throwing, and it takes the registry it
 * judges rather than reading the shipped one. Both for the reason ADR 0003 gives and
 * `statementLayoutFindings` follows one subject along: a rule that stops matching reports nothing, and
 * "the registry is sound" then passes over a registry that has stopped being one. A test can therefore
 * hand it a registry that DOES violate each rule and read back which rule fired, and
 * `scripts/test-gates.mjs` block 146 blinds each detector in the source and requires its own name back.
 *
 * It also takes a PROBE input, because the reads rule needs rows: a probe with an empty dataset makes
 * every reducer read nothing, which is a mismatch against a non-empty declaration and therefore a
 * failure rather than a pass. A probe that cannot make every measure read everything it declares is not
 * evidence about that measure.
 *
 * # What a dashboard may do with this
 *
 * {@link resolveKpi} is the only way to reach a KPI, and it throws {@link UnknownKpi} rather than
 * returning `undefined`, so a mistyped id on a screen is an error and never an empty tile.
 * `apps/web/src/kpi-arch.test.ts` holds the other half — that a page component resolves a REGISTERED id
 * and holds no SQL of its own — and the dashboard that will exercise it is R-REP-08's.
 */

// --- building a registry -------------------------------------------------------------------------

/**
 * One registered KPI: its declaration, its two rendered formulas, and the pure function that computes
 * it. Nothing here was typed twice — `formula`, `expandedFormula` and `compute` are all derived from
 * `expression`.
 */
export interface Kpi extends KpiSpec {
  /** The formula one level deep, naming the measures and KPIs it combines. */
  readonly formula: string
  /** The same formula with every KPI reference replaced by its own expression, down to the measures. */
  readonly expandedFormula: string
  /** The figure, or a `NoDenominator`. Pure: the same input gives the same answer, always. */
  readonly compute: (input: KpiInput) => KpiResult
}

/** A set of KPIs and the measures they are built from, with the lookups the rules need. */
export interface KpiRegistry {
  readonly kpis: readonly Kpi[]
  readonly measures: readonly Measure[]
  readonly byId: ReadonlyMap<string, Kpi>
  readonly measuresById: ReadonlyMap<string, Measure>
  readonly specsById: ReadonlyMap<string, KpiSpec>
}

/**
 * A registry from declarations: the formulas rendered, the expansions substituted, the functions
 * compiled.
 *
 * Exported so that a test, and the gate block, can build a DELIBERATELY broken one. A rules function
 * that could only ever see the shipped registry would be a rules function nobody had seen fire.
 */
export function buildKpiRegistry(
  specs: readonly KpiSpec[],
  measures: readonly Measure[],
): KpiRegistry {
  const measuresById = new Map(measures.map((measure) => [measure.id, measure]))
  const specsById = new Map(specs.map((spec) => [spec.id, spec]))
  const expressionOf = (id: string): KpiExpr | undefined => specsById.get(id)?.expression

  const kpis = specs.map((spec): Kpi => {
    const formula = renderExpr(spec.expression)
    return {
      ...spec,
      formula,
      // The path starts at this KPI's own id, so one that referenced itself prints its own name rather
      // than expanding for ever — which keeps a cyclic registry a failing rule and not a hung process.
      expandedFormula: renderExpr(expandExpr(spec.expression, expressionOf, [spec.id])),
      compute: (input: KpiInput): KpiResult => {
        const outcome = evaluateExpr(spec.expression, {
          input,
          measures: measuresById,
          kpis: specsById,
          visiting: new Set([spec.id]),
        })
        const common = { kpi: spec.id, unit: spec.unit, formula, provisional: spec.provisional }
        return outcome.ok
          ? { kind: 'measured', ...common, value: outcome.value }
          : { kind: 'no_denominator', ...common, divisorFormula: outcome.divisorFormula }
      },
    }
  })

  return {
    kpis,
    measures,
    byId: new Map(kpis.map((kpi) => [kpi.id, kpi])),
    measuresById,
    specsById,
  }
}

/** Every measure, from the two modules that declare them. */
export const KPI_MEASURES: readonly Measure[] = Object.freeze([
  ...UTILISATION_MEASURES,
  ...REVPAR_MEASURES,
])

/** Every KPI specification, in publication order. */
export const KPI_SPECS: readonly KpiSpec[] = Object.freeze([...UTILISATION_KPIS, ...REVPAR_KPIS])

/** The shipped registry. */
export const KPI_REGISTRY: KpiRegistry = buildKpiRegistry(KPI_SPECS, KPI_MEASURES)

/** Every registered KPI id, so a call site can enumerate them rather than spell one. */
export const KPI_IDS: readonly string[] = Object.freeze(KPI_REGISTRY.kpis.map((kpi) => kpi.id))

/** Every registered measure id. */
export const MEASURE_IDS: readonly string[] = Object.freeze(
  KPI_MEASURES.map((measure) => measure.id),
)

/** Raised when a KPI is asked for by a name the registry does not hold. */
export class UnknownKpi extends AppError {
  constructor(id: string, registered: readonly string[]) {
    super(
      'not_found',
      `No KPI "${id}" is registered. A screen that asked for one must not render an empty tile ` +
        'instead: a figure nobody can define is indistinguishable from a figure of zero.',
      { details: { id, registered: [...registered] } },
    )
    this.name = 'UnknownKpi'
  }
}

/** The registered KPI, or {@link UnknownKpi}. The only way to reach one. */
export function resolveKpi(id: string, registry: KpiRegistry = KPI_REGISTRY): Kpi {
  const kpi = registry.byId.get(id)
  if (kpi === undefined) throw new UnknownKpi(id, [...registry.byId.keys()])
  return kpi
}

/** The registered measure, or `undefined`. Exposed so a drill-down can name its own inputs. */
export const resolveMeasure = (
  id: string,
  registry: KpiRegistry = KPI_REGISTRY,
): Measure | undefined => registry.measuresById.get(id)

/**
 * A measured figure as a fixed-point decimal string, at the number of places its unit publishes to.
 *
 * It takes {@link MeasuredKpi} and not {@link KpiResult} deliberately: the caller has to narrow past the
 * no-denominator case first, so there is no code path from an empty denominator to a printed number.
 * That is the shape R-REP-07's "no numeric fallback branch" acceptance line asks for, available one unit
 * early because it costs nothing here.
 */
export const publishedFigure = (measured: MeasuredKpi): string =>
  formatFigure(measured.value, KPI_UNIT_DECIMALS[measured.unit])

// --- the rules -----------------------------------------------------------------------------------

/**
 * Every rule {@link kpiRegistryFindings} can report, in the order it reports them.
 *
 * Named, and asserted BY NAME: a rule that stops matching reports no findings, and a registry that has
 * stopped being sound then passes (ADR 0003). `scripts/test-gates.mjs` block 146 breaks each one and
 * requires its own name back.
 */
export const KPI_REGISTRY_RULES = [
  'registry-names-are-unique-across-kpis-and-measures',
  'registry-entry-carries-a-label-and-a-summary',
  'kpi-expression-references-only-registered-names',
  'kpi-expression-has-no-cycle',
  'kpi-formula-names-every-reference-it-computes',
  'kpi-unit-follows-from-its-expression',
  'measure-reads-exactly-the-fields-it-declares',
  'revparh-revenue-partition-claims-every-revenue-account-exactly-once',
] as const

export type KpiRegistryRule = (typeof KPI_REGISTRY_RULES)[number]

export interface KpiFinding {
  readonly rule: KpiRegistryRule
  readonly detail: string
}

/** The revenue partition the last rule judges, so a test can hand it a broken one. */
export interface RevenuePartition {
  readonly included: readonly AccountCode[]
  readonly excluded: readonly AccountCode[]
}

/** Whether `name` appears in `text` as a whole word, so a formula naming `x_ratio` is not `ratio`. */
const namesWord = (text: string, name: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(text)

/** Entries in `left` that `right` does not hold, sorted so a failure message is stable. */
const setDifference = (left: Iterable<string>, right: ReadonlySet<string>): readonly string[] =>
  [...left].filter((entry) => !right.has(entry)).sort()

const repeatedIn = (names: readonly string[]): readonly string[] =>
  [...new Set(names.filter((name, at) => names.indexOf(name) !== at))].sort()

/** Two things registered under one name, and an entry with nothing said about it. */
function nameFindings(registry: KpiRegistry): readonly KpiFinding[] {
  const findings: KpiFinding[] = []
  const repeated = repeatedIn([
    ...registry.kpis.map((kpi) => kpi.id),
    ...registry.measures.map((measure) => measure.id),
  ])
  if (repeated.length > 0) {
    findings.push({
      rule: 'registry-names-are-unique-across-kpis-and-measures',
      detail:
        `the name(s) [${repeated.join(', ')}] are registered more than once. A formula is rendered as ` +
        'names, so two things called one name make a published formula ambiguous and a resolution ' +
        'arbitrary',
    })
  }
  for (const entry of [...registry.kpis, ...registry.measures]) {
    const label = 'label' in entry ? entry.label : entry.id
    if (label.trim() === '' || entry.summary.trim() === '') {
      findings.push({
        rule: 'registry-entry-carries-a-label-and-a-summary',
        detail:
          `${entry.id} has an empty label or summary. A figure on a dashboard with no sentence saying ` +
          'what it is gets read as whatever the reader assumed it was',
      })
    }
  }
  return findings
}

/** Every measure a KPI reaches, directly or through another KPI, and the cycle if there is one. */
function transitiveMeasures(
  spec: KpiSpec,
  registry: KpiRegistry,
  seen: Set<string> = new Set(),
): { readonly measures: readonly string[]; readonly cycle: string | null } {
  if (seen.has(spec.id)) return { measures: [], cycle: spec.id }
  seen.add(spec.id)
  const direct = referencesOf(spec.expression)
  const measures = [...direct.measures]
  for (const id of direct.kpis) {
    const referenced = registry.specsById.get(id)
    if (referenced === undefined) continue
    const below = transitiveMeasures(referenced, registry, seen)
    if (below.cycle !== null) return { measures, cycle: below.cycle }
    for (const measure of below.measures) if (!measures.includes(measure)) measures.push(measure)
  }
  return { measures, cycle: null }
}

/** Every way one KPI's expression, rendered formula and declared unit fail to agree. */
function expressionFindings(spec: KpiSpec, registry: KpiRegistry): readonly KpiFinding[] {
  const direct = referencesOf(spec.expression)
  const unknownMeasures = direct.measures.filter((id) => !registry.measuresById.has(id))
  const unknownKpis = direct.kpis.filter((id) => !registry.specsById.has(id))
  if (unknownMeasures.length > 0 || unknownKpis.length > 0) {
    // Returning rather than going on: every rule below reads those references, so reporting them
    // against a name nothing defines would bury the one finding that says why.
    return [
      {
        rule: 'kpi-expression-references-only-registered-names',
        detail:
          `${spec.id} references unregistered measure(s) [${unknownMeasures.join(', ')}] and ` +
          `KPI(s) [${unknownKpis.join(', ')}], so its published formula names something nothing defines`,
      },
    ]
  }

  const transitive = transitiveMeasures(spec, registry)
  if (transitive.cycle !== null) {
    return [
      {
        rule: 'kpi-expression-has-no-cycle',
        detail:
          `${spec.id} reaches itself through ${transitive.cycle}. A KPI defined in terms of itself has ` +
          'no value, and its formula would expand for ever',
      },
    ]
  }

  const findings: KpiFinding[] = []
  const kpi = registry.byId.get(spec.id)
  const formula = kpi?.formula ?? ''
  const expanded = kpi?.expandedFormula ?? ''
  const missingFromFormula = [...direct.measures, ...direct.kpis]
    .filter((id) => !namesWord(formula, id))
    .sort()
  const missingFromExpansion = transitive.measures.filter((id) => !namesWord(expanded, id)).sort()
  if (formula.trim() === '' || missingFromFormula.length > 0 || missingFromExpansion.length > 0) {
    findings.push({
      rule: 'kpi-formula-names-every-reference-it-computes',
      detail:
        `${spec.id}'s formula "${formula}" does not name [${missingFromFormula.join(', ')}] and its ` +
        `expansion "${expanded}" does not name [${missingFromExpansion.join(', ')}]. The formula is ` +
        'rendered from the same expression the figure is computed from, so a name that is computed and ' +
        'not printed means the renderer dropped part of the arithmetic',
    })
  }

  const implied = unitOfExpr(spec.expression, {
    measures: registry.measuresById,
    kpis: registry.specsById,
  })
  if (implied !== spec.unit) {
    findings.push({
      rule: 'kpi-unit-follows-from-its-expression',
      detail:
        `${spec.id} declares the unit "${spec.unit}" and its expression implies ` +
        `"${implied ?? 'nothing'}". A unit stated beside an expression that does not imply it is how a ` +
        'count of minutes acquires a percentage sign',
    })
  }
  return findings
}

/** A measure's declaration held equal to what its reducer actually touched, in both directions. */
function measureReadFindings(registry: KpiRegistry, probe: KpiInput): readonly KpiFinding[] {
  const findings: KpiFinding[] = []
  for (const measure of registry.measures) {
    const declared = new Set<string>(measure.reads)
    const observed = recordedReads(probe, measure.reduce).reads
    const readNotDeclared = setDifference(observed, declared)
    const declaredNotRead = setDifference(declared, observed)
    if (readNotDeclared.length > 0 || declaredNotRead.length > 0) {
      findings.push({
        rule: 'measure-reads-exactly-the-fields-it-declares',
        detail:
          `${measure.id} reads [${readNotDeclared.join(', ')}] without declaring them and declares ` +
          `[${declaredNotRead.join(', ')}] without reading them. The second list is the one that ` +
          "matters: a denominator that stopped reading dim_date's own open_minutes and assumed a " +
          'constant number of hours would be correct today and wrong the first time the premises ' +
          'changed its hours, with no fixture failing',
      })
    }
  }
  return findings
}

/** The RevPARH revenue partition held equal to the chart's own revenue accounts. */
function revenuePartitionFindings(
  partition: RevenuePartition,
  chart: ChartOfAccounts,
): readonly KpiFinding[] {
  const revenueCodes = chart.accounts
    .filter((account) => account.type === 'revenue')
    .map((account) => account.code as string)
  const claimed = [...partition.included, ...partition.excluded].map((code) => code as string)
  const duplicated = repeatedIn(claimed)
  const unclaimed = revenueCodes.filter((code) => !claimed.includes(code)).sort()
  const foreign = claimed.filter((code) => !revenueCodes.includes(code)).sort()
  if (duplicated.length === 0 && unclaimed.length === 0 && foreign.length === 0) return []
  return [
    {
      rule: 'revparh-revenue-partition-claims-every-revenue-account-exactly-once',
      detail:
        `the RevPARH revenue partition claims [${duplicated.join(', ')}] twice, leaves ` +
        `[${unclaimed.join(', ')}] in neither side, and claims [${foreign.join(', ')}] which the chart ` +
        'does not hold as revenue. An unclaimed revenue account is revenue the numerator drops in ' +
        'silence; a foreign code is how the tips-payable LIABILITY would get into a revenue figure',
    },
  ]
}

/**
 * Every way the registry fails to be one, as named findings, in {@link KPI_REGISTRY_RULES} order.
 *
 * `probe` must hold at least one row in every dataset and must take every branch of every reducer: the
 * reads rule compares a declaration against what was ACTUALLY touched, so a probe with no included
 * revenue line makes `treatment_net_revenue_fils` skip `netFils` and the rule reports it. That is
 * intended and not a false positive — an EMPTY probe would otherwise make every reads check agree with
 * every declaration by reading nothing at all.
 */
export function kpiRegistryFindings(options: {
  readonly probe: KpiInput
  readonly registry?: KpiRegistry
  readonly chart?: ChartOfAccounts
  readonly revenuePartition?: RevenuePartition
}): readonly KpiFinding[] {
  const registry = options.registry ?? KPI_REGISTRY
  return [
    ...nameFindings(registry),
    ...registry.kpis.flatMap((kpi) => expressionFindings(kpi, registry)),
    ...measureReadFindings(registry, options.probe),
    ...revenuePartitionFindings(
      options.revenuePartition ?? REVPARH_REVENUE_PARTITION,
      options.chart ?? STANDARD_SPA_CHART,
    ),
  ]
}

/** Throws naming every rule that fired. The probe requirement is {@link kpiRegistryFindings}'. */
export function assertKpiRegistry(options: {
  readonly probe: KpiInput
  readonly registry?: KpiRegistry
  readonly chart?: ChartOfAccounts
  readonly revenuePartition?: RevenuePartition
}): void {
  const findings = kpiRegistryFindings(options)
  if (findings.length === 0) return
  throw new AppError(
    'invariant_violated',
    'The KPI registry is unsound. ' +
      findings.map((finding) => `${finding.rule}: ${finding.detail}`).join('; '),
    { details: { rules: findings.map((finding) => finding.rule) } },
  )
}

/** The unit vocabulary, re-exported so a consumer need not reach into the expression module. */
export type { KpiUnit }
