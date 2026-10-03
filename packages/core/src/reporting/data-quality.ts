import { AppError } from '@berelax/shared'
import type { KpiDataset, KpiExpr, KpiInput, KpiResult, Measure } from './kpi-expression.ts'
import { formatFigure, KPI_DATASETS, KPI_UNIT_DECIMALS, referencesOf } from './kpi-expression.ts'
import type { Kpi, KpiRegistry } from './kpi-registry.ts'
import { KPI_REGISTRY } from './kpi-registry.ts'
import type { KpiOutcome } from './operational-kpis.ts'

/**
 * The data-quality gate: a registry of reconciliation checks, and the one place a figure becomes
 * publishable (R-REP-07).
 *
 * # This is ADR 0070's rule applied to every reported number, not a second rule
 *
 * ADR 0070 decided that an unattributable cost is a refusal and never a zero, and stated it as
 * {@link KpiOutcome} — four states of which a number is one. ADR 0073 decided that a projection carries
 * its basis inside the figure rather than in a caveat beside it. This unit is the same decision one
 * level up: a figure whose RECONCILIATION is failing is also a refusal, and it is a refusal for exactly
 * ADR 0070's reason — the wrong number and the right number look identical on a tile, so the only place
 * the distinction survives is in the type.
 *
 * So {@link GatedFigure} **extends** `KpiOutcome` rather than restating it. The four refusal states are
 * not re-spelled here, which is the point: a second union with its own `value` branch would be a second
 * answer to "may this be printed", and the two would drift in the direction that prints something. The
 * three states added are the three this gate can discover and `KpiOutcome` cannot:
 *
 *   * `unreconciled` — two sides of one figure were compared and they disagree. It carries the variance
 *     and the check, and it carries **no value field at all**, which is `reconcileDispatches`' own
 *     arrangement (A-MEAS-07) for the same reason: a caller that could read a number off a refusal
 *     would read it.
 *   * `stale` — the materialised view the figure is derived from is older than
 *     {@link STALE_VIEW_AFTER_MINUTES}. A number from a view nobody refreshed is not wrong, which is
 *     what makes it dangerous: it is yesterday's answer to today's question with nothing on the screen
 *     saying so.
 *   * `unattested` — a check that gates this figure **has never run**. Deliberately not `unreconciled`:
 *     "the two sides disagree" and "nobody has ever compared them" are different claims, and the
 *     acceptance line that says a check which has never run reads `unknown` and never `pass` is the same
 *     distinction one layer down. Folding them together would report a build that has never reconciled
 *     anything as a build whose reconciliation is failing, and the first response to that is to look for
 *     the discrepancy rather than to run the pass.
 *
 * {@link publishGatedFigure} is the only function in this module that produces a printable number, and
 * it takes the `value` state alone. There is therefore no code path from a failing check to a figure —
 * not a path that is checked at runtime, a path that does not exist.
 *
 * # Why dependence is DERIVED and never declared beside a tile
 *
 * "every dependent tile renders the unreconciled state" needs an answer to which tiles depend on which
 * check, and the obvious shape is a list on the tile. That list is a second statement of what the KPI
 * reads, and it drifts silently: a KPI whose expression starts reading a new dataset keeps its old list
 * and keeps rendering a number.
 *
 * So a check declares the SUBJECTS it attests, a KPI's subjects are computed from the `reads`
 * declarations of its transitive measures — which `measure-reads-exactly-the-fields-it-declares` already
 * holds equal to what the reducers actually touch — and {@link checksGating} intersects the two. Nothing
 * is written twice, and a KPI that acquires a dataset acquires its checks on the same commit.
 *
 * # Pure
 *
 * No clock and no I/O. Every reading arrives as an argument from
 * `packages/db/src/reporting/data-quality-queries.ts`, including the instant staleness is measured
 * against, because a module that read the clock could not be asked "what did this look like then" — and
 * a data-quality screen whose answer cannot be reproduced is not evidence.
 */

// --- the subjects a check can attest --------------------------------------------------------------

/**
 * Subjects beyond {@link KPI_DATASETS}: the analytics series that no KPI dataset holds.
 *
 * Two of the seven checks are about traffic rather than about a KPI input — bot share and the ref
 * capture rate — and a registry that could only name KPI datasets would have had to either drop them or
 * pretend they attest a dataset they do not. Naming them makes the coverage rule below honest in both
 * directions: every KPI dataset is attested by something, and every check attests something that exists.
 */
export const DATA_QUALITY_EXTRA_SUBJECTS = ['analyticsSessions', 'conversionDispatches'] as const

/** Everything a check may attest. */
export const DATA_QUALITY_SUBJECTS = Object.freeze([
  ...KPI_DATASETS,
  ...DATA_QUALITY_EXTRA_SUBJECTS,
]) as readonly DataQualitySubject[]

export type DataQualitySubject = KpiDataset | (typeof DATA_QUALITY_EXTRA_SUBJECTS)[number]

// --- the checks -----------------------------------------------------------------------------------

/**
 * The registered checks, in the order the data-quality screen lists them.
 *
 * The order is publication order and it is not arbitrary: the identities over money first, then the
 * coverage of the series the money is attributed with, then the freshness of the views all of it is
 * read from. A reader working down the list reads the narrowest claim first.
 */
export const DATA_QUALITY_CHECK_IDS = [
  'ledger_vs_facts',
  'rollup_vs_raw',
  'attribution_coverage',
  'ref_capture',
  'bot_share',
  'dispatch_reconciliation',
  'view_freshness',
] as const

export type DataQualityCheckId = (typeof DATA_QUALITY_CHECK_IDS)[number]

/** The measure both sides of a check are counted in. Never a mixture, and never dimensionless. */
export type DataQualityMeasure = 'fils' | 'rows' | 'minutes'

/**
 * What the check claims about its two sides.
 *
 * `equals` is an identity and `at_most` a bound. Two members and not a comparator function, because a
 * function is not a thing a screen can print and the claim is what the reader has to see: "these two
 * figures are the same" and "this one is no larger than that one" are read differently, and a check
 * whose relation nobody stated gets read as whichever the reader assumed.
 */
export type DataQualityRelation = 'equals' | 'at_most'

export interface DataQualityCheck {
  readonly id: DataQualityCheckId
  readonly label: string
  /** What the check compares, and what a failure means. Printed beside the result. */
  readonly summary: string
  readonly measure: DataQualityMeasure
  readonly relation: DataQualityRelation
  /** The subjects this check attests. A figure reading any of them is gated by this check. */
  readonly attests: readonly DataQualitySubject[]
  /** The relation a drill-down lists rows from, and the predicate that selects the offending ones. */
  readonly drillDown: { readonly relation: string; readonly predicate: string }
}

/**
 * Minutes after which a materialised view's figures are stale.
 *
 * 26 hours, from R-REP-07's acceptance line, and the two hours over a day are the reason it is not 24:
 * the nightly refresh runs once a day, so a window of exactly a day calls every figure stale for however
 * long tonight's pass is late, and an alarm that fires on an ordinary variation is an alarm somebody
 * turns off. This build chose neither figure — the acceptance line did — so it is stated once, here, and
 * `reporting.refresh_run` is where the evidence comes from.
 */
export const STALE_VIEW_AFTER_MINUTES = 26 * 60

export const DATA_QUALITY_CHECKS: readonly DataQualityCheck[] = Object.freeze([
  {
    id: 'ledger_vs_facts',
    label: 'Revenue facts against the journal',
    summary:
      'The net revenue the sale facts carry for the window, against the movement on the revenue ' +
      'accounts over the same dates. One fils of disagreement means a figure on one screen cannot be ' +
      'traced to the books on another, and nothing downstream can say which of the two is right.',
    measure: 'fils',
    relation: 'equals',
    attests: ['revenueLines', 'cohortContributions'],
    drillDown: {
      relation: 'reporting.fact_sale joined to journal_line',
      predicate: 'the dates where the two sides differ, with the variance on each',
    },
  },
  {
    id: 'rollup_vs_raw',
    label: 'Facts against the rows they are built from',
    summary:
      'Each materialised fact counted against the public rows its definition selects. A rollup that ' +
      'has drifted from its own source is the failure a refresh is supposed to make impossible, which ' +
      'is exactly why nothing notices it: the view is a view and looks current.',
    measure: 'rows',
    relation: 'equals',
    attests: ['appointments', 'revenueLines', 'rosteredShifts'],
    drillDown: {
      relation: 'reporting.fact_appointment, fact_sale and fact_shift against their sources',
      predicate: 'the views whose row count differs from the rows their definition selects',
    },
  },
  {
    id: 'attribution_coverage',
    label: 'Attribution coverage',
    summary:
      'Every booking in the window is either attributed to a first touch or counted in the named gap ' +
      'cohort (ADR 0103). A census and not a percentage: a coverage target is a figure nobody here has ' +
      'chosen, and a booking that is in neither set is a booking the funnel has lost.',
    measure: 'rows',
    relation: 'equals',
    attests: ['cohortMembers', 'acquisitionSpend'],
    drillDown: {
      relation: 'booking_attribution against booking',
      predicate: 'bookings with neither an attribution row nor a gap-cohort reason',
    },
  },
  {
    id: 'ref_capture',
    label: 'Ref capture',
    summary:
      'Every WhatsApp ref this build issued is either redeemed against a session or recorded as ' +
      'expired. An issued ref in neither state is a conversation whose origin was lost between the ' +
      'message and the booking, so the campaign it came from is credited to nobody.',
    measure: 'rows',
    relation: 'equals',
    attests: ['acquisitionSpend', 'analyticsSessions'],
    drillDown: {
      relation: 'whatsapp_ref',
      predicate: 'refs that are neither redeemed nor expired',
    },
  },
  {
    id: 'bot_share',
    label: 'Session classification',
    summary:
      'Every analytics session is classified as human, bot or AI crawler. A census again rather than a ' +
      'share: this build has measured no bot share and a threshold invented here would decide which ' +
      'traffic reports counted. An unclassified session is one the classifier has never seen.',
    measure: 'rows',
    relation: 'equals',
    attests: ['analyticsSessions'],
    drillDown: {
      relation: 'analytics_session',
      predicate: 'sessions with no classification verdict',
    },
  },
  {
    id: 'dispatch_reconciliation',
    label: 'Conversion dispatch reconciliation',
    summary:
      'The last stored reconciliation pass per destination, as it answered. A destination whose pass ' +
      'answered unreconciled has been told something this business cannot produce from its own records, ' +
      'or has not been told something it should have been (A-MEAS-07).',
    measure: 'rows',
    relation: 'equals',
    attests: ['conversionDispatches'],
    drillDown: {
      relation: 'analytics_dispatch_reconciliation',
      predicate: 'the differences the last pass recorded, by kind',
    },
  },
  {
    id: 'view_freshness',
    label: 'View freshness',
    summary:
      'The age of the oldest materialised view, against the staleness window. It attests every subject ' +
      'because every figure in the reporting estate is read from one of these views: a figure from a ' +
      'view nobody refreshed is yesterday’s answer with nothing on the screen saying so.',
    measure: 'minutes',
    relation: 'at_most',
    attests: DATA_QUALITY_SUBJECTS,
    drillDown: {
      relation: 'reporting.materialised_view left joined to reporting.refresh_run',
      predicate: 'each view with the finish instant of its most recent refresh, oldest first',
    },
  },
] satisfies readonly DataQualityCheck[])

/** The checks by id. {@link resolveDataQualityCheck} is the only way through it. */
const CHECKS_BY_ID: ReadonlyMap<string, DataQualityCheck> = new Map(
  DATA_QUALITY_CHECKS.map((check) => [check.id, check]),
)

/** Raised when a check is asked for by a name the registry does not hold. */
export class UnknownDataQualityCheck extends AppError {
  constructor(id: string) {
    super(
      'not_found',
      `No data-quality check "${id}" is registered. A screen that asked for one must not render a ` +
        'blank row: a check nobody can define is indistinguishable from a check that passed.',
      { details: { id, registered: [...DATA_QUALITY_CHECK_IDS] } },
    )
    this.name = 'UnknownDataQualityCheck'
  }
}

/** The registered check, or {@link UnknownDataQualityCheck}. */
export function resolveDataQualityCheck(id: string): DataQualityCheck {
  const check = CHECKS_BY_ID.get(id)
  if (check === undefined) throw new UnknownDataQualityCheck(id)
  return check
}

// --- a reading, and the outcome it produces -------------------------------------------------------

/** One side of a check, as the database answered it. */
export interface DataQualitySide {
  readonly label: string
  readonly value: bigint
}

/**
 * What the database answered for one check, or the fact that nothing has.
 *
 * `observed` is `null` for a check whose producing pass has never run. Explicitly nullable and never
 * optional, for {@link KpiInput}'s reason stated one module along: an absent property and a property
 * nobody set are the same thing in JavaScript and different claims here, and the claim this one makes is
 * the whole of "a check that has never run reads unknown, never pass".
 */
export interface DataQualityReading {
  readonly checkId: DataQualityCheckId
  /** The instant the producing pass last ran, or `null` when it never has. */
  readonly lastRanAtIso: string | null
  /** The two sides, or `null` when there is nothing to compare because nothing has run. */
  readonly observed: {
    readonly left: DataQualitySide
    readonly right: DataQualitySide
    /** How many rows a drill-down would list. `0` on a passing check. */
    readonly offendingRows: number
  } | null
}

/** Every check's reading, keyed so a missing check is a type error rather than an absent row. */
export type DataQualityReadings = Readonly<Record<DataQualityCheckId, DataQualityReading>>

/**
 * A check's state. `unknown` is first because it is the state of this build before any pass has run,
 * and a reader of the union should meet it before `pass`.
 */
export type DataQualityState = 'unknown' | 'pass' | 'fail' | 'stale'

export interface DataQualityOutcome {
  readonly check: DataQualityCheck
  readonly state: DataQualityState
  readonly lastRanAtIso: string | null
  /** The two sides and the variance, or `null` for `unknown`. */
  readonly observed: {
    readonly left: DataQualitySide
    readonly right: DataQualitySide
    /** `left - right`, in the check's own measure. `0n` when the claim holds. */
    readonly variance: bigint
    readonly offendingRows: number
  } | null
  /** One sentence a screen prints beside the row. Never empty. */
  readonly detail: string
}

/**
 * One check's reading judged.
 *
 * The staleness check is the only one whose failure is `stale` rather than `fail`, and it is a property
 * of the CHECK rather than of this function: `view_freshness` is the one check whose relation is a bound
 * on an age. A second check about an age would have to say so here, which is the right place for that
 * decision to be visible.
 */
export function judgeDataQualityReading(reading: DataQualityReading): DataQualityOutcome {
  const check = resolveDataQualityCheck(reading.checkId)
  if (reading.observed === null) {
    return {
      check,
      state: 'unknown',
      lastRanAtIso: reading.lastRanAtIso,
      observed: null,
      detail:
        `No pass has produced a reading for ${check.id}, so this check has never run. That is ` +
        '"unknown" and not "pass": a comparison nobody has made is not a comparison that agreed.',
    }
  }
  const variance = reading.observed.left.value - reading.observed.right.value
  const holds = check.relation === 'equals' ? variance === 0n : variance <= 0n
  const observed = { ...reading.observed, variance }
  if (holds) {
    return {
      check,
      state: 'pass',
      lastRanAtIso: reading.lastRanAtIso,
      observed,
      detail:
        `${reading.observed.left.label} ${check.relation === 'equals' ? 'equals' : 'is within'} ` +
        `${reading.observed.right.label} (${reading.observed.right.value} ${check.measure}).`,
    }
  }
  return {
    check,
    state: check.id === 'view_freshness' ? 'stale' : 'fail',
    lastRanAtIso: reading.lastRanAtIso,
    observed,
    detail:
      `${reading.observed.left.label} is ${reading.observed.left.value} ${check.measure} and ` +
      `${reading.observed.right.label} is ${reading.observed.right.value} ${check.measure}, a ` +
      `variance of ${variance} ${check.measure} over ${reading.observed.offendingRows} row(s).`,
  }
}

/** Every check judged, in {@link DATA_QUALITY_CHECKS} order. */
export const judgeDataQuality = (readings: DataQualityReadings): readonly DataQualityOutcome[] =>
  Object.freeze(DATA_QUALITY_CHECKS.map((check) => judgeDataQualityReading(readings[check.id])))

// --- which checks gate which figure ---------------------------------------------------------------

/**
 * The datasets a KPI reads, through every measure it reaches.
 *
 * Derived from the measures' own `reads` declarations rather than from a list on the KPI, because that
 * list is held equal to what the reducers touch by `measure-reads-exactly-the-fields-it-declares` and a
 * list on the KPI would be held equal to nothing.
 */
export function datasetsOfKpi(
  kpi: Kpi,
  registry: KpiRegistry = KPI_REGISTRY,
): readonly DataQualitySubject[] {
  const datasets = new Set<string>()
  const visit = (expression: KpiExpr, seen: Set<string>): void => {
    const direct = referencesOf(expression)
    for (const id of direct.measures) {
      const measure = registry.measuresById.get(id)
      if (measure === undefined) continue
      for (const read of measure.reads) datasets.add(read.slice(0, read.indexOf('.')))
    }
    for (const id of direct.kpis) {
      // The cycle guard is the same one `expandedFormula` uses, and it is needed for the same reason: a
      // cyclic registry is a FAILING RULE in `kpiRegistryFindings`, not a reason for this walk to hang
      // while that rule is being reported.
      if (seen.has(id)) continue
      const spec = registry.specsById.get(id)
      if (spec === undefined) continue
      visit(spec.expression, new Set([...seen, id]))
    }
  }
  visit(kpi.expression, new Set([kpi.id]))
  return Object.freeze(DATA_QUALITY_SUBJECTS.filter((subject) => datasets.has(subject)))
}

/**
 * The checks that attest any of `subjects`, in registry order.
 *
 * `checks` is an argument with the shipped registry as its default, and that is not symmetry for its own
 * sake: `dataQualityFindings` calls this while judging a registry it was HANDED, and the first version
 * read the shipped one instead — so the rule about a KPI reaching no check could not fire for a
 * deliberately blinded registry, which is the only way it was ever going to be seen to fire. The two
 * cases in `data-quality.test.ts` that blind every check's `attests` are what found it.
 */
export const checksGating = (
  subjects: readonly DataQualitySubject[],
  checks: readonly DataQualityCheck[] = DATA_QUALITY_CHECKS,
): readonly DataQualityCheck[] =>
  checks.filter((check) => check.attests.some((subject) => subjects.includes(subject)))

/**
 * The datasets one MEASURE reads, from its own `reads` declaration.
 *
 * R-REP-08's headline tiles are measures rather than KPIs — a fold has a drill-down that can equal it
 * and a ratio does not — so the gate needs the same derivation one level down. It is the declaration and
 * not a walk, because a measure is a reducer and `measure-reads-exactly-the-fields-it-declares` already
 * holds that declaration equal to what the reducer touches, in both directions.
 */
export const datasetsOfMeasure = (measure: Measure): readonly DataQualitySubject[] => {
  const datasets = new Set(measure.reads.map((read) => read.slice(0, read.indexOf('.'))))
  return Object.freeze(DATA_QUALITY_SUBJECTS.filter((subject) => datasets.has(subject)))
}

/**
 * The KPIs every one of whose datasets is in `loaded`, in registry order.
 *
 * A dashboard may only offer a tile for one of these, and the reason is ADR 0070's again rather than
 * tidiness. A loader that supplies five of a KPI's six datasets makes the sixth read as EMPTY, and an
 * empty dataset is a figure of zero in a sum — so a utilisation whose closures were not loaded reports
 * every room as available all day, and the arithmetic does not say so. That is the same failure as a
 * zero cost, and the same answer applies: do not publish the figure.
 *
 * Derived from the measures' own `reads`, so a KPI that acquires a dataset drops off the dashboard on
 * the commit that widens it rather than starting to report a figure over a dataset nobody loaded.
 */
export const kpisComputableFrom = (
  loaded: readonly DataQualitySubject[],
  registry: KpiRegistry = KPI_REGISTRY,
): readonly Kpi[] =>
  registry.kpis.filter((kpi) =>
    datasetsOfKpi(kpi, registry).every((dataset) => loaded.includes(dataset)),
  )

/** The outcomes of the checks gating `subjects`, out of a full set of outcomes. */
export const outcomesGating = (
  outcomes: readonly DataQualityOutcome[],
  subjects: readonly DataQualitySubject[],
): readonly DataQualityOutcome[] => {
  const gating = new Set(checksGating(subjects).map((check) => check.id))
  return outcomes.filter((outcome) => gating.has(outcome.check.id))
}

// --- the gate -------------------------------------------------------------------------------------

/** A check that refused a figure, as a tile prints it. */
export interface GateRefusal {
  readonly checkId: DataQualityCheckId
  readonly label: string
  readonly detail: string
}

/**
 * A figure that has passed the gate, or any of the seven reasons it may not be printed.
 *
 * It EXTENDS {@link KpiOutcome} — the four states ADR 0070 decided are not restated here. See the
 * header for why the three added states are three and not one.
 */
export type GatedFigure<T> =
  | KpiOutcome<T>
  | {
      readonly state: 'unreconciled'
      readonly why: string
      /** No `value` field, deliberately: see the header. */
      readonly refusedBy: readonly GateRefusal[]
    }
  | {
      readonly state: 'stale'
      readonly why: string
      readonly refusedBy: readonly GateRefusal[]
    }
  | {
      readonly state: 'unattested'
      readonly why: string
      readonly refusedBy: readonly GateRefusal[]
    }

/** Every state a {@link GatedFigure} can be in, so a renderer can be held to covering all of them. */
export const GATED_FIGURE_STATES = [
  'value',
  'no_denominator',
  'no_data',
  'not_attributable',
  'unreconciled',
  'stale',
  'unattested',
] as const

export type GatedFigureState = (typeof GATED_FIGURE_STATES)[number]

const refusalOf = (outcome: DataQualityOutcome): GateRefusal => ({
  checkId: outcome.check.id,
  label: outcome.check.label,
  detail: outcome.detail,
})

/**
 * A figure gated on the checks that attest what it reads.
 *
 * The precedence is fail, then unknown, then stale, and it is the order of how much the reader is
 * entitled to conclude. A disagreement is a positive finding about the figure. "Nobody has checked" is
 * the absence of one. A stale view is a statement about the figure's age and not about its arithmetic,
 * so it is the weakest of the three — and it is last so that a stale view does not conceal a
 * disagreement that was found in it.
 *
 * Every refusal carries EVERY non-passing check and not just the deciding one, because the question a
 * reader asks next is "what else is wrong", and a screen that answered one reason at a time would be
 * read as having answered all of them.
 */
export function gateFigure<T>(
  figure: KpiOutcome<T>,
  outcomes: readonly DataQualityOutcome[],
): GatedFigure<T> {
  const failed = outcomes.filter((outcome) => outcome.state === 'fail')
  const unknown = outcomes.filter((outcome) => outcome.state === 'unknown')
  const stale = outcomes.filter((outcome) => outcome.state === 'stale')
  const refusedBy = [...failed, ...unknown, ...stale].map(refusalOf)
  if (failed.length > 0) {
    return {
      state: 'unreconciled',
      why:
        `${failed.length} reconciliation check(s) gating this figure do not hold, so the figure cannot ` +
        'be attributed to the records behind it. A number here would be indistinguishable from a ' +
        'correct one (ADR 0070).',
      refusedBy,
    }
  }
  if (unknown.length > 0) {
    return {
      state: 'unattested',
      why:
        `${unknown.length} reconciliation check(s) gating this figure have never run, so nothing has ` +
        'compared the two sides of it. That is not the same claim as a check that agreed.',
      refusedBy,
    }
  }
  if (stale.length > 0) {
    return {
      state: 'stale',
      why:
        'The materialised views this figure is read from are older than the staleness window, so this ' +
        'would be an earlier day’s answer with nothing beside it saying so.',
      refusedBy,
    }
  }
  return figure
}

/**
 * The gate over a registry KPI, start to finish: compute, judge, gate.
 *
 * One function so that a screen cannot do the three steps in the wrong order or skip the middle one.
 * `KpiResult` is adapted to {@link KpiOutcome} here rather than widened at its source: R-REP-03's
 * registry answers two states because a zero divisor is the only refusal an expression can reach, and
 * widening that union would make every KPI claim four states it cannot produce.
 */
export function gateKpi(args: {
  readonly kpi: Kpi
  readonly input: KpiInput
  readonly outcomes: readonly DataQualityOutcome[]
  readonly registry?: KpiRegistry
}): GatedFigure<KpiResult> {
  const registry = args.registry ?? KPI_REGISTRY
  const result = args.kpi.compute(args.input)
  const outcome: KpiOutcome<KpiResult> =
    result.kind === 'measured'
      ? { state: 'value', value: result }
      : {
          state: 'no_denominator',
          why:
            `${args.kpi.id}'s divisor ${result.divisorFormula} is zero over this period, which is an ` +
            'answer and not a figure of zero (ADR 0068).',
        }
  return gateFigure(outcome, outcomesGating(args.outcomes, datasetsOfKpi(args.kpi, registry)))
}

/**
 * The published figure, as a fixed-point decimal string.
 *
 * It takes the `value` state of a {@link GatedFigure} and nothing else, so there is no call that turns a
 * refusal into text that looks like a number. `publishedFigure` in `kpi-registry.ts` makes the same
 * narrowing one state earlier; this is the same arrangement with the gate in front of it.
 */
export function publishGatedFigure(
  figure: Extract<GatedFigure<KpiResult>, { state: 'value' }>,
): string {
  const measured = figure.value
  if (measured.kind !== 'measured') {
    throw new AppError(
      'invariant_violated',
      'publishGatedFigure was handed a value state carrying a non-measured result. The gate narrows to ' +
        'one state precisely so that this cannot be reached from a screen.',
    )
  }
  return formatFigure(measured.value, KPI_UNIT_DECIMALS[measured.unit])
}

// --- the rules ------------------------------------------------------------------------------------

/**
 * Every rule {@link dataQualityFindings} can report, in the order it reports them.
 *
 * Named and asserted BY NAME, for `kpiRegistryFindings`' reason (ADR 0003): a detector that stops
 * matching reports nothing, and "the check registry is sound" then passes over a registry that has
 * stopped being one. Gate block 198 blinds each one and requires its own name back.
 */
export const DATA_QUALITY_RULES = [
  'check-ids-are-unique-and-registered-in-declaration-order',
  'check-carries-a-label-and-a-summary',
  'check-attests-a-known-subject',
  'check-declares-a-drill-down',
  'every-kpi-dataset-is-attested-by-a-check',
  'every-kpi-is-gated-by-at-least-one-check',
] as const

export type DataQualityRule = (typeof DATA_QUALITY_RULES)[number]

export interface DataQualityFinding {
  readonly rule: DataQualityRule
  readonly detail: string
}

/**
 * Every way the check registry fails to be one, as named findings over an ARGUMENT.
 *
 * It takes the registry it judges so that a test and the gate block can hand it a registry that DOES
 * violate each rule and read back which rule fired — the arrangement `kpiRegistryFindings` and
 * `statementLayoutFindings` both use, and for the reason stated there: a rule nobody has seen fire is
 * not known to be a rule.
 */
export function dataQualityFindings(options?: {
  readonly checks?: readonly DataQualityCheck[]
  readonly kpiRegistry?: KpiRegistry
}): readonly DataQualityFinding[] {
  const checks = options?.checks ?? DATA_QUALITY_CHECKS
  const kpiRegistry = options?.kpiRegistry ?? KPI_REGISTRY
  const findings: DataQualityFinding[] = []

  const ids = checks.map((check) => check.id)
  const declared = [...DATA_QUALITY_CHECK_IDS]
  if (ids.length !== new Set(ids).size || ids.join(',') !== declared.join(',')) {
    findings.push({
      rule: 'check-ids-are-unique-and-registered-in-declaration-order',
      detail:
        `the registered checks are [${ids.join(', ')}] and the declared ids are ` +
        `[${declared.join(', ')}]. The screen lists them in registry order and the readings are keyed ` +
        'on the ids, so a check declared and not registered is a row that renders nothing and a check ' +
        'registered and not declared is a reading nothing produces',
    })
  }

  const subjects = new Set<string>(DATA_QUALITY_SUBJECTS)
  for (const check of checks) {
    if (check.label.trim() === '' || check.summary.trim() === '') {
      findings.push({
        rule: 'check-carries-a-label-and-a-summary',
        detail:
          `${check.id} has an empty label or summary. A red row on a data-quality screen with no ` +
          'sentence saying what was compared is a row somebody dismisses',
      })
    }
    const unknownSubjects = check.attests.filter((subject) => !subjects.has(subject))
    if (check.attests.length === 0 || unknownSubjects.length > 0) {
      findings.push({
        rule: 'check-attests-a-known-subject',
        detail:
          `${check.id} attests [${check.attests.join(', ')}], of which ` +
          `[${unknownSubjects.join(', ')}] are not subjects. A check attesting nothing gates nothing, ` +
          'and a check attesting a name nothing reads is a check whose failure stops no tile',
      })
    }
    if (check.drillDown.relation.trim() === '' || check.drillDown.predicate.trim() === '') {
      findings.push({
        rule: 'check-declares-a-drill-down',
        detail:
          `${check.id} declares no drill-down. A failing check with nowhere to look is a red row ` +
          'nobody can act on, and the acceptance line asks for the offending rows',
      })
    }
  }

  const attested = new Set(checks.flatMap((check) => [...check.attests]))
  const unattested = KPI_DATASETS.filter((dataset) => !attested.has(dataset))
  if (unattested.length > 0) {
    findings.push({
      rule: 'every-kpi-dataset-is-attested-by-a-check',
      detail:
        `no check attests [${unattested.join(', ')}], so a figure reading those datasets passes the ` +
        'gate because nothing looked at it. That is the one failure of this unit that looks exactly ' +
        'like success',
    })
  }

  const ungated = kpiRegistry.kpis
    .filter((kpi) => checksGating(datasetsOfKpi(kpi, kpiRegistry), checks).length === 0)
    .map((kpi) => kpi.id)
  if (ungated.length > 0) {
    findings.push({
      rule: 'every-kpi-is-gated-by-at-least-one-check',
      detail:
        `[${ungated.join(', ')}] reach no registered check, so their tiles would render a number ` +
        'whatever the state of the data. Dependence is derived from the measures’ reads, so a KPI ' +
        'that reaches nothing is either reading a dataset no check attests or reading nothing at all',
    })
  }

  return Object.freeze(findings)
}

/** Throws naming every rule that fired. */
export function assertDataQuality(options?: {
  readonly checks?: readonly DataQualityCheck[]
  readonly kpiRegistry?: KpiRegistry
}): void {
  const findings = dataQualityFindings(options)
  if (findings.length === 0) return
  throw new AppError(
    'invariant_violated',
    'The data-quality check registry is unsound. ' +
      findings.map((finding) => `${finding.rule}: ${finding.detail}`).join('; '),
    { details: { rules: findings.map((finding) => finding.rule) } },
  )
}
