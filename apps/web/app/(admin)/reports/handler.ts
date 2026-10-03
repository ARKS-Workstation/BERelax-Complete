import {
  bucketsAreContiguous,
  can,
  DASHBOARD_FOR_ROLE,
  dashboardScopeFor,
  type GatedFigure,
  gateTileFigure,
  judgeDataQuality,
  localDate,
  mayReadTile,
  REVPARH_REVENUE_PARTITION,
  type Role,
  resolveDashboardTile,
  STALE_VIEW_AFTER_MINUTES,
  selectableColumnsFor,
  tilesFor,
  tradingDayBuckets,
} from '@berelax/core'
import {
  AuditWriter,
  type DashboardDrillDownRow,
  dashboardDrillDown,
  dashboardTimeOfDay,
  dataQualityReadings,
  type KpiInputRows,
  kpiInputRows,
  raiseAlertNotification,
  type Sql,
} from '@berelax/db'
import { ALERT_OBSERVATION_WINDOW_HOURS, alertDefinition, isAppError } from '@berelax/shared'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'
import { renderDashboardHtml } from './render.ts'
import type { DashboardPayload, DashboardTileView, DashboardView, RenderDirection } from './view.ts'

/**
 * The role-scoped dashboard's handler (R-REP-08), driven directly by
 * `apps/web/src/dashboards.itest.ts`.
 *
 * ## Four things this file is responsible for, and the order they happen in
 *
 *   1. **The dashboard, from the ROLE.** `DASHBOARD_FOR_ROLE` and `tilesFor`, both in `@berelax/core`.
 *      A query parameter chooses the window and the tile to drill into and **never** the dashboard, the
 *      role or the scope: a repository-wide scan refuses a parameter that picks a principal, and the
 *      reason is that `?role=owner` is the shortest authorisation bypass anybody has ever written.
 *   2. **The scope, into the QUERY.** `dashboardScopeFor` gives a value; `kpiInputRows` and
 *      `dashboardDrillDown` take it and restrict inside the SQL. A dashboard that read everything and
 *      hid rows in the view would leak through the drill-down and through the export, which are the two
 *      things on this screen that return what the query returned.
 *   3. **The gate, before any figure is text.** Every tile's figure goes through `gateTileFigure`, so a
 *      tile whose reconciliation is failing renders R-REP-07's refusal rather than a number.
 *   4. **The export, as an audited act.** `audit_event` with `operation = 'export'` and the row count,
 *      plus the registered insider-threat alert, in one transaction.
 *
 * ## Why the export raises the alert itself
 *
 * `customer_list_export` is this build's one insider-threat alert and its observer polls
 * `rights_export` — the table a DATA-SUBJECT rights export writes. A report export writes no row there
 * and never should: it is not a right being exercised. So the nightly observer would never see it, and
 * the alert that exists for exactly this act would never fire for the surface most able to perform it.
 *
 * The export therefore raises the notification at the moment of export, with the tile, the subject kind
 * and the subject count in the detail, keyed on the audit row's own id so one export notifies once for
 * ever. It is the SAME registered alert — a second one would be a second answer to "an export happened"
 * with its own threshold and its own route, which ADR 0097 exists to prevent — and the threshold is the
 * registry's own structural 2, which a dashboard export always exceeds.
 *
 * ## No separate send path
 *
 * The pushed alerts are `apps/worker/src/jobs/report-alerts.ts`, through `deliverMessage` and therefore
 * through `sendMessage`: the template judgement, the sender-identity class rule, the promotional gate
 * and the F03 staging guard. Nothing is sent from here.
 */

export { DASHBOARD_PATH } from './view.ts'

/** The permission every dashboard request needs before its tiles are considered. */
export const DASHBOARD_READ_PERMISSION = 'report:read' as const

export const DASHBOARD_EXPORT_LIMIT = 500

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface DashboardPrincipal {
  readonly role: Role
  readonly employeeId: string
  readonly staffReference: string
}

export interface DashboardRequest {
  readonly searchParams: URLSearchParams
  readonly chrome: AdminChrome
  readonly principal: DashboardPrincipal
  readonly requestId: string | null
  /** Present on a POST. The export is a write and never a GET. */
  readonly body?: URLSearchParams
}

const text = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

/** The revenue accounts the net-revenue measure includes. The partition is `core`'s one statement. */
export const dashboardRevenueAccounts = (): readonly string[] =>
  REVPARH_REVENUE_PARTITION.included.map((code) => code as string)

/** Records a refusal. A refusal nobody recorded is indistinguishable from a request nobody made. */
async function recordDenied(
  sql: Sql,
  request: DashboardRequest,
  detail: Readonly<Record<string, unknown>>,
): Promise<void> {
  await new AuditWriter(
    sql,
    {
      kind: 'staff',
      id: request.principal.employeeId,
      label: request.principal.staffReference,
    },
    request.requestId === null ? {} : { requestId: request.requestId },
  ).record({
    action: 'report.dashboard_denied',
    entityType: 'report',
    entityId: 'dashboard',
    operation: 'denied',
    after: { role: request.principal.role, ...detail },
  })
}

/** The loaded rows as a `KpiInput`, with the five cohort datasets empty because the type is total. */
const kpiInputOf = (rows: KpiInputRows) => ({
  businessDays: rows.businessDays.map((row) => ({
    businessDay: localDate(row.businessDay),
    openMinutes: row.openMinutes,
  })),
  roomDays: rows.roomDays.map((row) => ({
    businessDay: localDate(row.businessDay),
    roomId: row.roomId,
  })),
  roomClosures: rows.roomClosures.map((row) => ({
    businessDay: localDate(row.businessDay),
    roomId: row.roomId,
    fromMinuteAfterOpen: row.fromMinuteAfterOpen,
    toMinuteAfterOpen: row.toMinuteAfterOpen,
  })),
  appointments: rows.appointments.map((row) => ({
    businessDay: localDate(row.businessDay),
    roomId: row.roomId,
    employeeId: row.employeeId,
    isDelivered: row.isDelivered,
    treatmentMinutes: row.treatmentMinutes,
    turnaroundMinutes: row.turnaroundMinutes,
  })),
  rosteredShifts: rows.rosteredShifts.map((row) => ({
    businessDay: localDate(row.businessDay),
    employeeId: row.employeeId,
    rosteredMinutes: row.rosteredMinutes,
  })),
  revenueLines: rows.revenueLines.map((row) => ({
    businessDay: localDate(row.businessDay),
    accountCode: row.accountCode as never,
    netFils: row.netFils,
  })),
  cohortMembers: [],
  cohortMonths: [],
  cohortContributions: [],
  acquisitionSpend: [],
  packageEntitlements: [],
})

const figureOf = (gated: GatedFigure<bigint>): DashboardTileView['figure'] =>
  gated.state === 'value'
    ? // The ONE place a dashboard figure becomes text, and it takes the `value` state alone. Every
      // refusal is passed through with no numeric field on it for a renderer to find (ADR 0120).
      { state: 'value', value: gated.value.toString() }
    : gated

/** Everything both serialisations share, computed once. Exported so a suite can read it without HTTP. */
export async function dashboardPayload(
  sql: Sql,
  args: {
    readonly role: Role
    readonly employeeId: string
    readonly window: { readonly fromInclusive: string; readonly toInclusive: string }
    readonly asOfIso: string
    readonly drillTileId: string | null
    readonly limit?: number
  },
): Promise<DashboardPayload> {
  const dashboard = DASHBOARD_FOR_ROLE[args.role]
  if (dashboard === null) {
    throw new Error(
      `${args.role} has no dashboard, which the handler must answer 403 to before reaching here.`,
    )
  }
  const scope = dashboardScopeFor(args.role, args.employeeId)
  const revenueAccountCodes = dashboardRevenueAccounts()
  const scopedToEmployeeId = scope.kind === 'own_employee' ? scope.employeeId : null

  const readings = await dataQualityReadings(sql, {
    window: args.window,
    asOfIso: args.asOfIso,
    staleAfterMinutes: STALE_VIEW_AFTER_MINUTES,
    revenueAccountCodes,
  })
  const outcomes = judgeDataQuality(readings)

  const rows = await kpiInputRows(sql, {
    window: args.window,
    revenueAccountCodes,
    scopedToEmployeeId,
  })
  const input = kpiInputOf(rows)

  const tiles = tilesFor(args.role).map((tile) => ({
    tileId: tile.tileId,
    label: tile.label,
    measureId: tile.measureId,
    rowGrain: tile.rowGrain,
    figure: figureOf(gateTileFigure({ tile, input, outcomes })),
    businessWide: tile.businessWide,
  }))

  // The buckets come from the FIRST trading day in the window and its own open minutes, so a day with
  // a dated override produces its own number of buckets. `dim_date` is the authority, derived from
  // `premises_hours` and its overrides: an opening and closing time written into this file would be
  // wrong on exactly the days somebody set an override for, and `nap-hours-literal-outside-the-seed`
  // in `packages/db/src/seed/premises.test.ts` refuses one — including in a comment, which is how this
  // paragraph came to be worded without a clock in it.
  const firstDay = rows.businessDays[0]
  const [opening] =
    firstDay === undefined
      ? []
      : await sql<{ opensAtHour: number }[]>`
        select extract(hour from (opens_at at time zone 'Asia/Dubai'))::int as "opensAtHour"
          from reporting.dim_date
         where business_day = ${firstDay.businessDay}::date
      `
  const buckets =
    firstDay === undefined || opening === undefined
      ? []
      : tradingDayBuckets({
          opensAtHour: opening.opensAtHour,
          openMinutes: firstDay.openMinutes,
        })
  const timeOfDay = await dashboardTimeOfDay(sql, { window: args.window, scopedToEmployeeId })

  const columns = selectableColumnsFor(args.role)
  const drillDown =
    args.drillTileId === null
      ? null
      : await (async () => {
          const tile = resolveDashboardTile(args.drillTileId ?? '')
          const drillRows = await dashboardDrillDown(sql, {
            tileId: tile.tileId,
            window: args.window,
            scopedToEmployeeId,
            columns,
            revenueAccountCodes,
            ...(args.limit === undefined ? {} : { limit: args.limit }),
          })
          // `sum(amount)` as a bigint, because the M5 identity is to the fils and a `number` would
          // round a figure the gate exists to protect.
          let aggregate = 0n
          for (const row of drillRows) aggregate += BigInt(row.amount ?? '0')
          return {
            tileId: tile.tileId,
            rowGrain: tile.rowGrain,
            rows: drillRows,
            aggregate: aggregate.toString(),
          }
        })()

  return {
    dashboard,
    scope,
    window: { from: args.window.fromInclusive, to: args.window.toInclusive },
    asOfIso: args.asOfIso,
    tiles,
    buckets,
    timeOfDay,
    bucketsAreContiguous: bucketsAreContiguous(buckets),
    drillDown,
    columns,
    provenance: rows.provenance,
  }
}

/** `GET /reports`. The window is required; the dashboard is the role's. */
export async function handleDashboardRead(
  request: DashboardRequest,
  deps: { readonly sql: Sql; readonly now: () => number },
): Promise<Response> {
  const wantsJson = request.searchParams.get('format') === 'json'
  const from = request.searchParams.get('from')
  const to = request.searchParams.get('to')
  if (from === null || to === null || !ISO_DATE.test(from) || !ISO_DATE.test(to) || to < from) {
    const message =
      'This dashboard reports on one window of trading dates. Pass ?from=YYYY-MM-DD&to=YYYY-MM-DD. ' +
      'There is deliberately no default: a screen that answered for "the last thirty days" answers a ' +
      'different question every day, so a figure quoted from it cannot be traced back.\n'
    return wantsJson ? json({ error: 'window_required', detail: message }, 400) : text(message, 400)
  }
  const at = request.searchParams.get('at')
  const instant = at === null ? deps.now() : Date.parse(at)
  if (Number.isNaN(instant)) {
    const message = `?at=${at} is not an instant this page can parse.\n`
    return wantsJson
      ? json({ error: 'unreadable_instant', detail: message }, 400)
      : text(message, 400)
  }
  const asOfIso = new Date(instant).toISOString()

  const refusal = await refuse(request, deps.sql)
  if (refusal !== null) return wantsJson ? json(refusal.body, 403) : text(refusal.message, 403)

  const drillTileId = request.searchParams.get('tile')
  const payload = await dashboardPayload(deps.sql, {
    role: request.principal.role,
    employeeId: request.principal.employeeId,
    window: { fromInclusive: from, toInclusive: to },
    asOfIso,
    drillTileId,
  })

  if (wantsJson) return json(serialise(payload), 200)
  // `?dir=rtl` is a LAYOUT axis and not a locale: the document is English in both directions. See
  // `render.ts`'s `RenderDirection`.
  const direction: RenderDirection = request.searchParams.get('dir') === 'rtl' ? 'rtl' : 'ltr'
  return new Response(
    renderDashboardHtml({ chrome: request.chrome, direction, ...payload } satisfies DashboardView),
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached dashboard outlives the window it was true for, and the figures on it
        // are ones somebody acts on.
        'cache-control': 'no-store',
      },
    },
  )
}

/** The three refusals, in the order they are asked. `null` means the request may proceed. */
async function refuse(
  request: DashboardRequest,
  sql: Sql,
): Promise<{ readonly message: string; readonly body: unknown } | null> {
  const role = request.principal.role
  if (DASHBOARD_FOR_ROLE[role] === null) {
    await recordDenied(sql, request, { reason: 'no_dashboard_for_role' })
    return {
      message: `Role "${role}" has no reporting dashboard, so this screen is refused. The refusal is recorded.\n`,
      body: { error: 'forbidden', reason: 'no_dashboard_for_role' },
    }
  }
  const tileId = request.searchParams.get('tile') ?? request.body?.get('tile') ?? null
  if (tileId !== null && !mayReadTile(role, tileId)) {
    // The acceptance line: a therapist asking for the business-wide P&L tile. A 403 and a row, not an
    // empty tile — an empty tile is indistinguishable from a business with no takings.
    await recordDenied(sql, request, { reason: 'tile_not_permitted', tileId })
    return {
      message: `Role "${role}" may not read the tile "${tileId}", so this request is refused. The refusal is recorded.\n`,
      body: { error: 'forbidden', reason: 'tile_not_permitted', tileId },
    }
  }
  return null
}

/** The JSON body. `bigint` never reaches it: every figure is already a decimal string. */
const serialise = (payload: DashboardPayload) => ({
  dashboard: payload.dashboard,
  scope: payload.scope,
  window: payload.window,
  asOf: payload.asOfIso,
  tiles: payload.tiles,
  buckets: payload.buckets,
  timeOfDay: payload.timeOfDay,
  bucketsAreContiguous: payload.bucketsAreContiguous,
  drillDown: payload.drillDown,
  columns: payload.columns,
  provenance: payload.provenance,
})

/**
 * What the export needs beyond a connection: a way to run its two writes in ONE transaction.
 *
 * A dependency and not `sql.begin` inside the handler, and the reason is a real failure rather than
 * taste: a postgres.js TRANSACTION handle has `savepoint` and no `begin`, so a handler that opened its
 * own transaction worked when the caller passed a pool and threw `deps.sql.begin is not a function`
 * when the caller passed a transaction — which is exactly how `apps/web/src/dashboards.itest.ts` drives
 * it. Declaring the requirement makes the route supply a real transaction and the suite supply the one
 * it is already inside, and neither has to know what the other did.
 */
export interface DashboardExportDeps {
  readonly sql: Sql
  readonly now: () => number
  readonly withTransaction: <T>(run: (tx: Sql) => Promise<T>) => Promise<T>
}

/**
 * `POST /reports` with `tile=…` — the export.
 *
 * One transaction: the rows, the `audit_event` with `operation = 'export'` and the row count, and the
 * insider-threat alert. All three or none, because an export with no audit row is the thing the trail
 * exists to make impossible, and an audit row for an export that failed is a false record.
 */
export async function handleDashboardExport(
  request: DashboardRequest,
  deps: DashboardExportDeps,
): Promise<Response> {
  const body = request.body ?? new URLSearchParams()
  const tileId = body.get('tile')
  const from = body.get('from')
  const to = body.get('to')
  if (
    tileId === null ||
    from === null ||
    to === null ||
    !ISO_DATE.test(from) ||
    !ISO_DATE.test(to) ||
    to < from
  ) {
    return text(
      'An export names one tile and one window: tile=<tileId>, from=YYYY-MM-DD, to=YYYY-MM-DD.\n',
      400,
    )
  }
  const refusal = await refuse({ ...request, body }, deps.sql)
  if (refusal !== null) return text(refusal.message, 403)
  if (!can(request.principal.role, DASHBOARD_READ_PERMISSION)) {
    // A role may hold a tile through `rota:read` and still not be a reporting role. An EXPORT is the
    // wider act — a file that leaves the building — so it needs the report permission as well.
    await recordDenied(deps.sql, request, { reason: 'export_needs_report_read', tileId })
    return text(
      `Role "${request.principal.role}" may read this tile on the screen and may not export it: an ` +
        `export is a file that leaves the building and needs ${DASHBOARD_READ_PERMISSION}. The ` +
        'refusal is recorded.\n',
      403,
    )
  }

  try {
    const tile = resolveDashboardTile(tileId)
    const scope = dashboardScopeFor(request.principal.role, request.principal.employeeId)
    const rows = await dashboardDrillDown(deps.sql, {
      tileId: tile.tileId,
      window: { fromInclusive: from, toInclusive: to },
      scopedToEmployeeId: scope.kind === 'own_employee' ? scope.employeeId : null,
      columns: selectableColumnsFor(request.principal.role),
      revenueAccountCodes: dashboardRevenueAccounts(),
      limit: DASHBOARD_EXPORT_LIMIT,
    })
    // The subjects the export covers: the distinct people its rows are about. `employee_reference` is
    // an internal handle (ADR 0020) and still identifies a person, which is what a subject count is.
    const subjects = new Set(
      rows.map((row) => row.employeeReference).filter((reference) => reference !== undefined),
    )
    const definition = alertDefinition('customer_list_export')
    const threshold = definition.threshold.kind === 'structural' ? definition.threshold.value : 2

    const csv = [
      selectableColumnsFor(request.principal.role).join(','),
      ...rows.map((row) =>
        selectableColumnsFor(request.principal.role)
          .map((column) => csvCell(row, column))
          .join(','),
      ),
    ].join('\n')

    const auditId = await deps.withTransaction(async (tx) => {
      const writer = new AuditWriter(
        tx,
        {
          kind: 'staff',
          id: request.principal.employeeId,
          label: request.principal.staffReference,
        },
        request.requestId === null ? {} : { requestId: request.requestId },
      )
      await writer.recordExport('report', rows.length, 'report.dashboard_export')
      const [row] = await tx<{ id: string }[]>`
        select id::text as id from audit_event
         where action = 'report.dashboard_export' and operation = 'export'
         order by occurred_at desc, id desc limit 1
      `
      const id = row?.id ?? `${tile.tileId}:${from}:${to}`
      await raiseAlertNotification(tx, {
        alertId: definition.id,
        severity: definition.severity,
        runbook: definition.runbook,
        observed: subjects.size,
        threshold,
        // The audit row's own id, so one export notifies once for ever whatever a pass schedule is —
        // `observeCustomerListExport`'s arrangement, with the export this build CAN see.
        incidentKey: `report_export:${id}`,
        detail: {
          tileId: tile.tileId,
          subjectKind: 'employee',
          subjectCount: subjects.size,
          rowCount: rows.length,
          window: { from, to },
          scope: scope.kind,
          observationWindowHours: ALERT_OBSERVATION_WINDOW_HOURS,
        },
      })
      return id
    })

    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${tile.tileId}-${from}-${to}.csv"`,
        // The audit row's id, so the file and the trail entry can be tied together by whoever reviews
        // the alert. Not the actor and not the role: nothing identifying goes in a header.
        'x-audit-event': auditId,
      },
    })
  } catch (error) {
    const message = isAppError(error) ? error.message : 'Unexpected'
    return text(`The export could not be produced: ${message}\n`, 503)
  }
}

/** One CSV cell, quoted. A figure is already a string; a missing column renders empty. */
function csvCell(row: DashboardDrillDownRow, column: string): string {
  const keys: Readonly<Record<string, keyof DashboardDrillDownRow>> = {
    business_day: 'businessDay',
    tile_id: 'tileId',
    subject_id: 'subjectId',
    amount: 'amount',
    detail: 'detail',
    employee_reference: 'employeeReference',
    customer_label: 'customerLabel',
    customer_spend_fils: 'customerSpendFils',
    employee_wage_fils: 'employeeWageFils',
    clinical_note: 'clinicalNote',
  }
  const key = keys[column]
  const value = key === undefined ? undefined : row[key]
  return value === undefined ? '' : `"${String(value).replaceAll('"', '""')}"`
}
