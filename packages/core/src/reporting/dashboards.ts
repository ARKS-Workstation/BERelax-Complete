import { AppError } from '@berelax/shared'
import type { FieldGroup, Permission, Role } from '../access/permissions.ts'
import { can, canReadFieldGroup, ROLES } from '../access/permissions.ts'
import type { DataQualityOutcome, GatedFigure } from './data-quality.ts'
import { datasetsOfMeasure, gateFigure, outcomesGating } from './data-quality.ts'
import type { KpiInput, Measure } from './kpi-expression.ts'
import { KPI_REGISTRY, type KpiRegistry } from './kpi-registry.ts'

/**
 * The role-scoped dashboards: which tiles a role gets, what SCOPE its queries run under, which columns
 * may be serialised to it, and the trading window as buckets (R-REP-08).
 *
 * # Role-scoped means the scope is in the QUERY
 *
 * The obvious implementation of a role-scoped dashboard is one query and a view that hides the rows the
 * role may not see. It leaks twice, and both leaks are reachable from the same screen: a drill-down asks
 * for the rows behind a tile, and an export writes them to a file. Either returns what the query
 * returned, not what the view drew.
 *
 * So {@link DashboardScope} is a VALUE the query takes — `own_employee` carries the employee id and the
 * SQL restricts on it — and {@link selectableColumnsFor} is the projection the query selects, not a
 * filter applied afterwards. A column a role may not read is absent from the serialised payload because
 * it was never fetched.
 *
 * # A headline tile is a registered MEASURE, which is what makes the drill-down identity exact
 *
 * The M5 gate is *every headline tile drills to source rows whose aggregate equals the tile value
 * exactly*. That is a claim a ratio cannot keep: utilisation is `a ÷ b` and no list of rows sums to it.
 * So a headline tile's source is one of R-REP-03's {@link Measure}s — a fold over one dataset, with its
 * `reads` declaration already held equal to what the reducer touches (ADR 0068) — and the drill-down is
 * the rows that fold ran over. The aggregate is then the same arithmetic on both sides rather than two
 * implementations of one figure, which is the only way the identity can be asserted for every tile
 * rather than for a sample.
 *
 * A ratio belongs on this dashboard too, and it arrives as R-REP-07's gated KPI tile — which carries its
 * formula and its own refusal states and makes no drill-down claim.
 *
 * # Deny by default, and the refusal is a row
 *
 * {@link DASHBOARD_FOR_ROLE} is a total map over {@link ROLES} with `null` for a role that has no
 * dashboard, so a role added to F07 and forgotten here is a `pnpm typecheck` failure and not a role that
 * inherits somebody else's screen. {@link tilesFor} then removes any tile whose permission or field
 * groups the role lacks, so the two layers agree by construction: a tile is on the dashboard because the
 * matrix allows it, never because this file listed it.
 *
 * # Pure
 *
 * No clock, no I/O, no row. The buckets are derived from a day's own open window rather than from a
 * literal 11:00–02:00, because the premises hours are a row (`premises_hours` and its dated overrides)
 * and a window spelled here would be a second answer to when the salon trades — wrong on exactly the
 * days somebody set an override for.
 */

// --- the dashboards -------------------------------------------------------------------------------

export const DASHBOARD_IDS = ['owner', 'manager', 'accountant', 'therapist'] as const

export type DashboardId = (typeof DASHBOARD_IDS)[number]

/**
 * One headline tile: the measure behind it, what it takes to see it, and what its rows touch.
 *
 * `fieldGroups` is what the DRILL-DOWN rows reach, not what the figure reaches. A total of rostered
 * minutes discloses nothing; the rows behind it name employees, and a role that may not read an
 * employment field may not have the rows either. Keeping the two on one entry is what stops a tile being
 * granted on the strength of its aggregate.
 */
export interface DashboardTile {
  readonly tileId: string
  readonly label: string
  /** The registered measure. The figure and the drill-down are the same fold over the same rows. */
  readonly measureId: string
  /** What one row of the drill-down IS, in a sentence. */
  readonly rowGrain: string
  readonly requires: Permission
  readonly fieldGroups: readonly FieldGroup[]
  /** `true` for a figure about the business as a whole, which a scoped role may not see at all. */
  readonly businessWide: boolean
}

/**
 * The headline tiles, in publication order.
 *
 * Four, and each is a fold with an exact drill-down. `net_revenue` is the business-wide P&L figure the
 * acceptance line names — the one a therapist must be refused — and it requires `report:financial`,
 * which in F07 is held by the owner, the accountant and the auditor and by nobody else.
 */
export const DASHBOARD_TILES: readonly DashboardTile[] = Object.freeze([
  {
    tileId: 'net_revenue',
    label: 'Net revenue',
    measureId: 'treatment_net_revenue_fils',
    rowGrain: 'one journal line crediting a treatment-revenue account on one trading date',
    requires: 'report:financial',
    fieldGroups: [],
    businessWide: true,
  },
  {
    tileId: 'occupied_room_minutes',
    label: 'Room minutes occupied',
    measureId: 'room_occupied_minutes',
    rowGrain: 'one delivered appointment holding a room, with its treatment and turnaround minutes',
    requires: 'report:read',
    fieldGroups: [],
    businessWide: true,
  },
  {
    tileId: 'rostered_minutes',
    label: 'Minutes rostered',
    measureId: 'therapist_rostered_minutes',
    rowGrain: 'one employee on one shift, with the minutes they were rostered for',
    // `rota:read` and NOT `report:read`, and the difference is the therapist. F07 gives the therapist
    // no reporting permission at all — which this unit's own test found — so a dashboard gated on
    // `report:read` would have refused them every tile while the layout claimed they had a screen. A
    // therapist's own rostered minutes is a fact about the roster they are already entitled to read,
    // and that is the narrower grant: widening F07 to give them `report:read` would have handed them
    // every other report in the build as well.
    requires: 'rota:read',
    // No field group. The drill-down names an employee REFERENCE — the employment record's internal
    // handle, which names no person (ADR 0020) and is what the diary already shows — and no figure
    // here is a wage. `employee.salary` would refuse the manager a tile about the roster they publish.
    fieldGroups: [],
    businessWide: false,
  },
  {
    tileId: 'treatment_minutes',
    label: 'Minutes delivered',
    measureId: 'therapist_treatment_minutes',
    rowGrain: 'one delivered appointment with a therapist, with its treatment minutes',
    // `booking:read` for `rostered_minutes`' reason: the therapist's own delivered minutes are a fact
    // about appointments they already read, and the business-wide reading of the same measure is what
    // `occupied_room_minutes` is for.
    requires: 'booking:read',
    fieldGroups: [],
    businessWide: false,
  },
] satisfies readonly DashboardTile[])

/**
 * Which tiles each dashboard PUBLISHES, before the matrix narrows them.
 *
 * Two layers rather than one, and the second is what makes the first safe: this map says what the screen
 * is for, and {@link tilesFor} removes anything the role may not have. A single map would be a second
 * statement of the F07 matrix, and the way that fails is the direction that grants.
 */
export const DASHBOARD_LAYOUT: Readonly<Record<DashboardId, readonly string[]>> = Object.freeze({
  owner: DASHBOARD_TILES.map((tile) => tile.tileId),
  manager: ['occupied_room_minutes', 'rostered_minutes', 'treatment_minutes'],
  accountant: ['net_revenue'],
  therapist: ['treatment_minutes', 'rostered_minutes'],
})

/**
 * The dashboard a role gets, or `null`.
 *
 * A total map over {@link ROLES}, so a role added to F07 is a `pnpm typecheck` failure here rather than
 * a role that silently inherits whichever screen a `??` pointed at. `null` is a 403, not an empty page:
 * a blank dashboard is indistinguishable from a business with no takings.
 */
export const DASHBOARD_FOR_ROLE: Readonly<Record<Role, DashboardId | null>> = Object.freeze({
  owner: 'owner',
  manager: 'manager',
  accountant: 'accountant',
  // The auditor reads, and what they read is the financial picture. Pointing them at the accountant's
  // screen rather than the owner's is the narrower grant and is what `report:financial` without
  // `settings:write` means.
  auditor: 'accountant',
  therapist: 'therapist',
  // The front desk and the marketer have screens of their own elsewhere, and neither needs a reporting
  // dashboard: the receptionist's job is the diary and the till, and the marketer works in segments and
  // counts that the analytics page serves. A dashboard for them would be a wider grant than either role
  // has ever asked for.
  receptionist: null,
  marketer: null,
  // No interactive login exists for this role (F07), so there is no screen to put anything on.
  system: null,
})

/** Raised when a dashboard is asked for by a name nothing publishes. */
export class UnknownDashboardTile extends AppError {
  constructor(tileId: string) {
    super('not_found', `No dashboard tile "${tileId}" is registered.`, {
      details: { tileId, registered: DASHBOARD_TILES.map((tile) => tile.tileId) },
    })
    this.name = 'UnknownDashboardTile'
  }
}

export function resolveDashboardTile(tileId: string): DashboardTile {
  const tile = DASHBOARD_TILES.find((entry) => entry.tileId === tileId)
  if (tile === undefined) throw new UnknownDashboardTile(tileId)
  return tile
}

// --- the scope ------------------------------------------------------------------------------------

/**
 * What a principal's queries are restricted to.
 *
 * A VALUE the query takes, never a filter applied to its result. `own_employee` is the therapist: their
 * dashboard is about their own delivered minutes and their own roster, and the restriction is a
 * `where employee_id = …` inside the aggregate rather than a row the view declined to draw.
 */
export type DashboardScope =
  | { readonly kind: 'business' }
  | { readonly kind: 'own_employee'; readonly employeeId: string }

/**
 * The scope a role runs under.
 *
 * The therapist is the only scoped role in F07 today, and the decision is theirs rather than a property
 * of the tile: a tile is business-wide or it is not, and a role either sees the business or sees itself.
 * A role with no dashboard has no scope and is refused before this is reached.
 */
export function dashboardScopeFor(role: Role, employeeId: string): DashboardScope {
  if (role !== 'therapist') return { kind: 'business' }
  if (employeeId.trim() === '') {
    throw new AppError(
      'invariant_violated',
      'A therapist dashboard needs the signed-in employee id to scope its queries. An empty id would ' +
        'restrict on nothing, which is the whole business rather than one person.',
    )
  }
  return { kind: 'own_employee', employeeId }
}

/**
 * The tiles a role really gets: its dashboard's, minus every one the matrix refuses it.
 *
 * Three refusals, and the third is the one a permission check alone would miss. A `businessWide` tile is
 * removed from a SCOPED role entirely rather than restricted, because the figure it names — the
 * business's net revenue — has no per-person reading: a scoped version of it would be a different
 * figure under the same label, which is how a therapist comes to quote the salon's takings as their own.
 */
export function tilesFor(
  role: Role,
  options?: {
    readonly tiles?: readonly DashboardTile[]
    readonly layout?: Readonly<Record<DashboardId, readonly string[]>>
    readonly forRole?: Readonly<Record<Role, DashboardId | null>>
  },
): readonly DashboardTile[] {
  const tiles = options?.tiles ?? DASHBOARD_TILES
  const layout = options?.layout ?? DASHBOARD_LAYOUT
  const dashboard = (options?.forRole ?? DASHBOARD_FOR_ROLE)[role]
  if (dashboard === null || dashboard === undefined) return []
  const published = new Set(layout[dashboard] ?? [])
  const scope = role === 'therapist' ? 'own_employee' : 'business'
  return tiles.filter(
    (tile) =>
      published.has(tile.tileId) &&
      can(role, tile.requires) &&
      tile.fieldGroups.every((group) => canReadFieldGroup(role, group)) &&
      !(tile.businessWide && scope === 'own_employee'),
  )
}

/** Whether a role may have this tile at all. The one question the handler asks before a drill-down. */
export const mayReadTile = (role: Role, tileId: string): boolean =>
  tilesFor(role).some((tile) => tile.tileId === tileId)

/**
 * One tile's figure, folded by its measure and then GATED by R-REP-07's checks.
 *
 * Pure, and in `core` rather than in the handler, for the reason R-REP-07's `gateKpi` is: the three
 * steps — fold, judge, gate — have to happen in that order and a screen that could do them separately
 * could skip the middle one. The dependence is derived from the measure's own `reads` through
 * {@link datasetsOfMeasure}, so a measure that acquires a dataset acquires its checks on the same
 * commit.
 */
export function gateTileFigure(args: {
  readonly tile: DashboardTile
  readonly input: KpiInput
  readonly outcomes: readonly DataQualityOutcome[]
  readonly registry?: KpiRegistry
}): GatedFigure<bigint> {
  const registry = args.registry ?? KPI_REGISTRY
  const measure = registry.measuresById.get(args.tile.measureId)
  if (measure === undefined) {
    throw new AppError(
      'invariant_violated',
      `The tile "${args.tile.tileId}" names the measure "${args.tile.measureId}", which the registry ` +
        'does not hold. `tile-names-a-registered-measure` is the rule that refuses this, and reaching ' +
        'here means the declarations were not asserted before they were rendered.',
      { details: { tileId: args.tile.tileId, measureId: args.tile.measureId } },
    )
  }
  return gateFigure(
    { state: 'value', value: measure.reduce(args.input) },
    outcomesGating(args.outcomes, datasetsOfMeasure(measure)),
  )
}

// --- the columns ----------------------------------------------------------------------------------

/**
 * Every column a dashboard drill-down can select, classified.
 *
 * **CLOSED, not open.** `redactForRole` keeps an unmapped field, which is right for a customer record
 * where most fields are innocuous and wrong here for `packages/core/src/hr/employee.ts`'s reason: a
 * dashboard row is mostly about a person, so the field somebody forgets to classify is the one most
 * likely to be a wage or a clinical note. {@link selectableColumnsFor} builds the projection from this
 * map, so a column nobody classified is not selected by anybody.
 */
export const DASHBOARD_COLUMN_GROUPS: Readonly<Record<string, FieldGroup | 'operational'>> =
  Object.freeze({
    business_day: 'operational',
    tile_id: 'operational',
    subject_id: 'operational',
    amount: 'operational',
    detail: 'operational',
    // The employment record's internal handle, which names no person (ADR 0020) and is what the diary
    // and every audit row already carry. Operational and not `employee.identity_documents`: a visa
    // number is an identity document and a handle is a label.
    employee_reference: 'operational',
    customer_label: 'customer.contact',
    customer_spend_fils: 'customer.spend_history',
    employee_wage_fils: 'employee.salary',
    clinical_note: 'clinical.notes',
  })

/** The columns, in a stable order, so two runs of a drill-down produce the same payload shape. */
export const DASHBOARD_COLUMNS: readonly string[] = Object.freeze(
  Object.keys(DASHBOARD_COLUMN_GROUPS).sort(),
)

/**
 * A classification a test may hand in, including one with a column nobody classified.
 *
 * `undefined` is a member on purpose. `DASHBOARD_COLUMNS` is derived from the shipped map's own keys, so
 * the unclassified case is unreachable through the shipped constants — which made the `return false`
 * below dead code and the rule about it unfireable, exactly the defect `checksGating` had one unit
 * earlier. Taking the map as an argument is what lets `dashboards.test.ts` hand in a column with no
 * group and require it to be refused.
 */
export type DashboardColumnClassification = Readonly<
  Record<string, FieldGroup | 'operational' | undefined>
>

/**
 * The columns a role may have serialised.
 *
 * `operational` columns are the row's own identity and figure and are granted to anybody who has the
 * tile; every other column is granted only through its field group. The projection is built from this,
 * so a forbidden column is ABSENT from the payload rather than blanked — which is the acceptance line,
 * and the difference between a column a reader cannot see and a column that is not there.
 */
export const selectableColumnsFor = (
  role: Role,
  columnGroups: DashboardColumnClassification = DASHBOARD_COLUMN_GROUPS,
): readonly string[] =>
  Object.keys(columnGroups)
    .sort()
    .filter((column) => {
      const group = columnGroups[column]
      // CLOSED: a column nobody classified is refused to everybody, including the owner. The opposite
      // default is `redactForRole`'s and is right for a customer record; here the column somebody
      // forgets to classify is the one most likely to be a wage.
      if (group === undefined) return false
      return group === 'operational' || canReadFieldGroup(role, group)
    })

/** The columns a role may NOT have, so a test can assert their absence by name rather than by list. */
export const forbiddenColumnsFor = (
  role: Role,
  columnGroups: DashboardColumnClassification = DASHBOARD_COLUMN_GROUPS,
): readonly string[] => {
  const allowed = new Set(selectableColumnsFor(role, columnGroups))
  return Object.keys(columnGroups)
    .sort()
    .filter((column) => !allowed.has(column))
}

// --- the trading window ---------------------------------------------------------------------------

/** One hour of the trading window, in business-day order. */
export interface TradingBucket {
  /** 0 for the hour the premises opened, counting forward across midnight. */
  readonly index: number
  /** The hour of the clock this bucket starts at, 0–23. */
  readonly startHour: number
  /** `HH:00`, so a screen prints the same label a reader would read off a clock. */
  readonly label: string
}

/**
 * The trading window as contiguous hour buckets, in BUSINESS-DAY order.
 *
 * Derived from the day's own open instant and length, never from a literal 11:00–02:00: the premises
 * hours are `premises_hours` and its dated overrides, `business_day.duration_seconds` is generated from
 * them, and a window spelled in this file would be wrong on exactly the days somebody set an override —
 * a Ramadan schedule, a public holiday, a late close. For the standard day the answer is 15 buckets
 * (11:00 through 01:00), which is what R-REP-08's acceptance line names.
 *
 * Business-day order is the point of the function. The hours run 11, 12, … 23, 0, 1, and any sort by the
 * clock would put the two busiest hours of the evening at the START of the chart — the same defect
 * `resolveTradingDate` exists to prevent one subject along, drawn rather than computed.
 *
 * A window that does not divide into whole hours is rounded UP to the bucket that contains its last
 * minute, because a chart that dropped the final forty minutes would drop takings.
 */
export function tradingDayBuckets(args: {
  readonly opensAtHour: number
  readonly openMinutes: number
}): readonly TradingBucket[] {
  if (!Number.isInteger(args.opensAtHour) || args.opensAtHour < 0 || args.opensAtHour > 23) {
    throw new AppError(
      'validation',
      `A trading window opens at an hour of the clock, 0 to 23; got ${args.opensAtHour}.`,
    )
  }
  if (!Number.isInteger(args.openMinutes) || args.openMinutes <= 0) {
    throw new AppError(
      'validation',
      `A trading window is a positive whole number of minutes; got ${args.openMinutes}. A day the ` +
        'premises did not trade has no row in business_day at all, so zero is not a window.',
    )
  }
  const hours = Math.ceil(args.openMinutes / 60)
  return Object.freeze(
    Array.from({ length: hours }, (_unused, index) => {
      const startHour = (args.opensAtHour + index) % 24
      return {
        index,
        startHour,
        label: `${String(startHour).padStart(2, '0')}:00`,
      }
    }),
  )
}

/** Whether a bucket list is contiguous in business-day order, which a chart cannot check for itself. */
export const bucketsAreContiguous = (buckets: readonly TradingBucket[]): boolean =>
  buckets.every((bucket, at) => {
    if (bucket.index !== at) return false
    const previous = buckets[at - 1]
    return previous === undefined || bucket.startHour === (previous.startHour + 1) % 24
  })

// --- the rules ------------------------------------------------------------------------------------

export const DASHBOARD_RULES = [
  'every-role-is-mapped-to-a-dashboard-or-to-nothing',
  'tile-names-a-registered-measure',
  'tile-states-its-row-grain',
  'published-tile-is-registered',
  'every-selectable-column-is-classified',
  'a-scoped-role-publishes-no-business-wide-tile',
] as const

export type DashboardRule = (typeof DASHBOARD_RULES)[number]

export interface DashboardFinding {
  readonly rule: DashboardRule
  readonly detail: string
}

/**
 * The rule about a SCOPED dashboard's layout, split out so `dashboardFindings` stays under the
 * complexity ceiling.
 *
 * It reads the LAYOUT and not `tilesFor`. That function already drops a business-wide tile for a scoped
 * role, so a rule reading it would be checking the post-condition of its own filter and could never
 * fire — which is what the first version did, and what `dashboards.test.ts` found.
 */
function scopedLayoutFindings(
  tiles: readonly DashboardTile[],
  layout: Readonly<Record<DashboardId, readonly string[]>>,
  forRole: Readonly<Record<Role, DashboardId | null>>,
): readonly DashboardFinding[] {
  const businessWide = new Set(tiles.filter((tile) => tile.businessWide).map((tile) => tile.tileId))
  const findings: DashboardFinding[] = []
  for (const role of ROLES) {
    const dashboard = forRole[role]
    if (dashboard === null || dashboard === undefined) continue
    // `dashboardScopeFor` is the one place that says who is scoped; read rather than restated.
    if (dashboardScopeFor(role, 'probe-employee').kind === 'business') continue
    const leaked = (layout[dashboard] ?? []).filter((tileId) => businessWide.has(tileId))
    if (leaked.length === 0) continue
    findings.push({
      rule: 'a-scoped-role-publishes-no-business-wide-tile',
      detail:
        `the ${dashboard} dashboard is scoped to one employee and publishes [${leaked.join(', ')}]. ` +
        'A business-wide figure has no per-person reading, so a scoped version of it would be a ' +
        'different figure under the same label',
    })
  }
  return findings
}

/** One tile's own two rules. Split out so `dashboardFindings` stays under the complexity ceiling. */
function tileFindings(tile: DashboardTile, registry: KpiRegistry): readonly DashboardFinding[] {
  const findings: DashboardFinding[] = []
  const measure: Measure | undefined = registry.measuresById.get(tile.measureId)
  if (measure === undefined) {
    findings.push({
      rule: 'tile-names-a-registered-measure',
      detail:
        `${tile.tileId} names the measure "${tile.measureId}", which R-REP-03's registry does not ` +
        'hold. A tile whose figure is not a registered fold has no drill-down that can equal it, ' +
        'because there is no declaration of what it reads',
    })
  }
  if (tile.rowGrain.trim() === '') {
    findings.push({
      rule: 'tile-states-its-row-grain',
      detail:
        `${tile.tileId} states no row grain, so what one row of its drill-down IS is left to the ` +
        'reader — and the M5 gate is about a list of rows adding up to a figure',
    })
  }
  return findings
}

/**
 * Every way the dashboard declarations fail to be usable, as named findings over ARGUMENTS.
 *
 * Findings and not a throw, and over arguments rather than over the shipped constants, for
 * `kpiRegistryFindings`' reason (ADR 0003): a rule that stops matching reports nothing, and "the
 * dashboards are sound" then passes over declarations that have stopped being.
 */
export function dashboardFindings(options?: {
  readonly tiles?: readonly DashboardTile[]
  readonly layout?: Readonly<Record<DashboardId, readonly string[]>>
  readonly forRole?: Readonly<Record<Role, DashboardId | null>>
  readonly columnGroups?: Readonly<Record<string, FieldGroup | 'operational'>>
  readonly registry?: KpiRegistry
}): readonly DashboardFinding[] {
  const tiles = options?.tiles ?? DASHBOARD_TILES
  const layout = options?.layout ?? DASHBOARD_LAYOUT
  const forRole = options?.forRole ?? DASHBOARD_FOR_ROLE
  const columnGroups = options?.columnGroups ?? DASHBOARD_COLUMN_GROUPS
  const registry = options?.registry ?? KPI_REGISTRY
  const findings: DashboardFinding[] = []

  const unmapped = ROLES.filter((role) => !(role in forRole))
  if (unmapped.length > 0) {
    findings.push({
      rule: 'every-role-is-mapped-to-a-dashboard-or-to-nothing',
      detail:
        `[${unmapped.join(', ')}] have no entry, so the role falls through to whatever a lookup ` +
        'returns for a missing key — which is how a role added to F07 inherits somebody else’s screen',
    })
  }

  const registered = new Set(tiles.map((tile) => tile.tileId))
  for (const tile of tiles) findings.push(...tileFindings(tile, registry))

  for (const [dashboard, published] of Object.entries(layout)) {
    const unknown = published.filter((tileId) => !registered.has(tileId))
    if (unknown.length > 0) {
      findings.push({
        rule: 'published-tile-is-registered',
        detail:
          `the ${dashboard} dashboard publishes [${unknown.join(', ')}], which no tile declares. A ` +
          'layout naming a tile nothing defines renders an empty box, and an empty box on a revenue ' +
          'dashboard reads as a figure of nothing',
      })
    }
  }

  const unclassified = Object.entries(columnGroups)
    .filter(([, group]) => group === undefined)
    .map(([column]) => column)
  if (unclassified.length > 0 || Object.keys(columnGroups).length === 0) {
    findings.push({
      rule: 'every-selectable-column-is-classified',
      detail:
        `[${unclassified.join(', ')}] are selectable and unclassified. The classification is CLOSED ` +
        'here, unlike redactForRole’s default, because a dashboard row is mostly about a person and ' +
        'the field somebody forgets is the one most likely to be a wage',
    })
  }

  findings.push(...scopedLayoutFindings(tiles, layout, forRole))

  return Object.freeze(findings)
}

/** Throws naming every rule that fired. */
export function assertDashboards(options?: Parameters<typeof dashboardFindings>[0]): void {
  const findings = dashboardFindings(options)
  if (findings.length === 0) return
  throw new AppError(
    'invariant_violated',
    'The dashboard declarations are unsound. ' +
      findings.map((finding) => `${finding.rule}: ${finding.detail}`).join('; '),
    { details: { rules: findings.map((finding) => finding.rule) } },
  )
}
