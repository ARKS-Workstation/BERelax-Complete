import {
  can,
  DATA_QUALITY_CHECKS,
  type DataQualityOutcome,
  type DataQualityReadings,
  type DataQualitySubject,
  gateKpi,
  judgeDataQuality,
  type KpiInput,
  kpisComputableFrom,
  localDate,
  type Permission,
  publishGatedFigure,
  STALE_VIEW_AFTER_MINUTES,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import {
  AuditWriter,
  type DataQualityArgs,
  dataQualityDrillDown,
  dataQualityReadings,
  KPI_INPUT_LOADED_DATASETS,
  type KpiInputRows,
  kpiInputRows,
  type Sql,
} from '@berelax/db'
import type { KpiTileProps } from '@berelax/ui/reporting'
import type { AdminChrome } from '../../../../src/components/admin/google-reauth-banner.ts'
import { type DataQualityCheckView, renderDataQualityHtml } from './render.ts'

/**
 * The data-quality screen's handler (R-REP-07), driven directly by
 * `apps/web/src/data-quality.itest.ts`.
 *
 * ## Why a handler module and not everything in `route.ts`
 *
 * `next start` serves whatever `.next` was last built, so a suite that drove the route over HTTP would
 * assert against a stale build on every commit that did not rebuild — the split G-REV-02 and G-REV-06
 * both record, with the measured consequence: *"four cases reported 'exited zero; nothing was rejected'
 * against a stale build."* So the HTTP plumbing (the session guard, the connection, the chrome) is
 * `route.ts`'s, and everything a mutation to this unit would change is here and is driven against real
 * PostgreSQL with no server at all.
 *
 * ## One computation serves the API and the rendered layer
 *
 * R-REP-07's acceptance line requires the unreconciled state asserted "at both the API and the rendered
 * layer". `format: 'json'` and `format: 'html'` are two serialisations of ONE
 * {@link DataQualityPayload}: a second code path for the JSON would be a second answer to "is this
 * figure publishable", and the two would drift in the direction that publishes.
 *
 * ## The permission, and why a refusal is a row
 *
 * F07's `report:read`. A refusal writes `audit_event` with `operation = 'denied'` — a refusal nobody
 * recorded is indistinguishable from a request nobody made, and the trail is this build's
 * insider-threat control (docs/06 §D4). A query parameter may never choose a principal, a role or a
 * permission: the role arrives on the principal, which `route.ts` resolves from the session cookie.
 */

/** The permission this report requires. One constant, so the handler and its suite cannot disagree. */
export const DATA_QUALITY_PERMISSION: Permission = 'report:read'

/** The path, spelled once, so the registry entry, the drill-down link and the suite agree. */
export const DATA_QUALITY_PATH = '/reports/data-quality'

/** The drill-down page. A page, not a cap on the claim: each check's own count is taken in SQL. */
export const DATA_QUALITY_DRILL_DOWN_LIMIT = 25

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Everything the two serialisations share. Computed once. */
export interface DataQualityPayload {
  readonly window: { readonly from: string; readonly to: string }
  readonly asOfIso: string
  readonly staleAfterMinutes: number
  readonly registeredChecks: number
  readonly checks: readonly DataQualityCheckView[]
  readonly tiles: readonly KpiTileProps[]
  readonly provenance: KpiInputRows['provenance']
}

export interface DataQualityPrincipal {
  readonly role: Parameters<typeof can>[0]
  readonly employeeId: string
  readonly staffReference: string
}

export interface DataQualityRequest {
  readonly searchParams: URLSearchParams
  readonly chrome: AdminChrome
  readonly principal: DataQualityPrincipal
  readonly requestId: string | null
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

/** The revenue accounts, from the chart. Never a literal: the chart is the one statement of them. */
export const revenueAccountCodes = (): readonly string[] =>
  STANDARD_SPA_CHART.accounts
    .filter((account) => account.type === 'revenue')
    .map((account) => account.code as string)

/**
 * The checks, flattened, with a drill-down loaded only for the ones that did not hold.
 *
 * Not for a passing check, which would be a query per check per view for rows that do not exist; and
 * not for an `unknown` one, which would be worse — an empty table under a check that has never run
 * reads as a check that looked and found nothing.
 */
async function checkViews(
  sql: Sql,
  outcomes: readonly DataQualityOutcome[],
  args: DataQualityArgs,
): Promise<readonly DataQualityCheckView[]> {
  const views: DataQualityCheckView[] = []
  for (const outcome of outcomes) {
    const rows =
      outcome.state === 'fail' || outcome.state === 'stale'
        ? await dataQualityDrillDown(sql, {
            ...args,
            checkId: outcome.check.id,
            limit: DATA_QUALITY_DRILL_DOWN_LIMIT,
          })
        : []
    views.push({
      checkId: outcome.check.id,
      label: outcome.check.label,
      summary: outcome.check.summary,
      state: outcome.state,
      measure: outcome.check.measure,
      relation: outcome.check.relation === 'equals' ? 'an identity' : 'a bound',
      lastRanAtIso: outcome.lastRanAtIso,
      observed:
        outcome.observed === null
          ? null
          : {
              leftLabel: outcome.observed.left.label,
              // `String(bigint)` and never `Number(bigint)`: a fils figure this page is about may not
              // be rounded on its way out, and `JSON.stringify` cannot serialise a bigint at all.
              leftValue: String(outcome.observed.left.value),
              rightLabel: outcome.observed.right.label,
              rightValue: String(outcome.observed.right.value),
              variance: String(outcome.observed.variance),
              offendingRows: outcome.observed.offendingRows,
            },
      detail: outcome.detail,
      attests: [...outcome.check.attests],
      drillDown: [...rows],
      drillDownRelation: outcome.check.drillDown.relation,
      drillDownPredicate: outcome.check.drillDown.predicate,
    })
  }
  return views
}

/**
 * The loaded rows as a {@link KpiInput}.
 *
 * The five cohort datasets are empty arrays because the type is total, NOT because the datasets are
 * empty — they are a cohort-month grain and this window is trading dates. `kpisComputableFrom` has
 * already dropped every KPI that reads one, so no figure is computed over them.
 */
const kpiInputOf = (rows: KpiInputRows): KpiInput => ({
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
    accountCode: row.accountCode as KpiInput['revenueLines'][number]['accountCode'],
    netFils: row.netFils,
  })),
  cohortMembers: [],
  cohortMonths: [],
  cohortContributions: [],
  acquisitionSpend: [],
  packageEntitlements: [],
})

/** The whole payload for one window, gate included. Exported so a suite can read it without HTTP. */
export async function dataQualityPayload(
  sql: Sql,
  args: DataQualityArgs,
): Promise<DataQualityPayload> {
  const readings = await dataQualityReadings(sql, args)
  // The db module's reading set annotated as `core`'s type. That annotation IS the check holding the
  // two statements of the shape equal: a field renamed on either side is a typecheck failure here
  // rather than a reading nothing judges.
  const judged = judgeDataQuality(readings satisfies DataQualityReadings)
  const checks = await checkViews(sql, judged, args)
  const rows = await kpiInputRows(sql, {
    window: args.window,
    revenueAccountCodes: args.revenueAccountCodes,
  })
  const input = kpiInputOf(rows)
  const loaded = [...KPI_INPUT_LOADED_DATASETS] as DataQualitySubject[]
  const tiles: KpiTileProps[] = kpisComputableFrom(loaded).map((kpi) => {
    const gated = gateKpi({ kpi, input, outcomes: judged })
    return {
      kpiId: kpi.id,
      label: kpi.label,
      formula: kpi.formula,
      unit: kpi.unit,
      // The ONE place a figure becomes text, and it takes the `value` state alone. Every other state
      // is passed through with no numeric field on it for a renderer to find.
      figure:
        gated.state === 'value' ? { state: 'value', value: publishGatedFigure(gated) } : gated,
      drillDownHref: `${DATA_QUALITY_PATH}?from=${args.window.fromInclusive}&to=${args.window.toInclusive}`,
    }
  })
  return {
    window: { from: args.window.fromInclusive, to: args.window.toInclusive },
    asOfIso: args.asOfIso,
    staleAfterMinutes: args.staleAfterMinutes,
    registeredChecks: DATA_QUALITY_CHECKS.length,
    checks,
    tiles,
    provenance: rows.provenance,
  }
}

/**
 * `GET /reports/data-quality`, as a function of its parameters and a connection.
 *
 * The window is REQUIRED and has no default: a page that answered for "the last thirty days" would
 * answer a different question every day, so a link to it could not be cited — and this page is cited,
 * because it is the evidence that a figure somebody acted on was sound at the time.
 */
export async function handleDataQualityRead(
  request: DataQualityRequest,
  deps: { readonly sql: Sql; readonly now: () => number },
): Promise<Response> {
  const wantsJson = request.searchParams.get('format') === 'json'
  const from = request.searchParams.get('from')
  const to = request.searchParams.get('to')
  if (from === null || to === null || !ISO_DATE.test(from) || !ISO_DATE.test(to) || to < from) {
    const message =
      'This page reports on one window of trading dates. Pass ?from=YYYY-MM-DD&to=YYYY-MM-DD, for ' +
      'example ?from=2026-09-01&to=2026-09-30. There is deliberately no default: a page that answered ' +
      'for "the last thirty days" would answer a different question every day, and this page is the ' +
      'evidence that a figure somebody acted on was sound at the time.\n'
    return wantsJson ? json({ error: 'window_required', detail: message }, 400) : text(message, 400)
  }

  const at = request.searchParams.get('at')
  const instant = at === null ? deps.now() : Date.parse(at)
  if (Number.isNaN(instant)) {
    const message =
      `?at=${at} is not an instant this page can parse. A parameter that quietly did nothing would ` +
      'make "as of then" answer for now and look right.\n'
    return wantsJson
      ? json({ error: 'unreadable_instant', detail: message }, 400)
      : text(message, 400)
  }
  const asOfIso = new Date(instant).toISOString()

  if (!can(request.principal.role, DATA_QUALITY_PERMISSION)) {
    await new AuditWriter(
      deps.sql,
      {
        kind: 'staff',
        id: request.principal.employeeId,
        label: request.principal.staffReference,
      },
      request.requestId === null ? {} : { requestId: request.requestId },
    ).record({
      action: 'report.data_quality_denied',
      entityType: 'report',
      entityId: 'data-quality',
      operation: 'denied',
      after: { role: request.principal.role, permission: DATA_QUALITY_PERMISSION },
    })
    const message =
      `Role "${request.principal.role}" may not ${DATA_QUALITY_PERMISSION}, so this report is ` +
      'refused. The refusal is recorded.\n'
    return wantsJson
      ? json({ error: 'forbidden', permission: DATA_QUALITY_PERMISSION }, 403)
      : text(message, 403)
  }

  const payload = await dataQualityPayload(deps.sql, {
    window: { fromInclusive: from, toInclusive: to },
    asOfIso,
    staleAfterMinutes: STALE_VIEW_AFTER_MINUTES,
    revenueAccountCodes: revenueAccountCodes(),
  })

  if (wantsJson) {
    return json(
      {
        window: payload.window,
        asOf: payload.asOfIso,
        staleAfterMinutes: payload.staleAfterMinutes,
        registeredChecks: payload.registeredChecks,
        checks: payload.checks,
        tiles: payload.tiles.map((tile) => ({
          kpiId: tile.kpiId,
          label: tile.label,
          formula: tile.formula,
          unit: tile.unit,
          figure: tile.figure,
        })),
        provenance: payload.provenance,
      },
      200,
    )
  }

  return new Response(
    renderDataQualityHtml({
      chrome: request.chrome,
      windowFrom: payload.window.from,
      windowTo: payload.window.to,
      asOfIso: payload.asOfIso,
      checks: payload.checks,
      tiles: payload.tiles,
      staleAfterMinutes: payload.staleAfterMinutes,
    }),
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached data-quality page is a claim that the figures were sound outliving the
        // moment it was true for, which is the one thing this page must never do.
        'cache-control': 'no-store',
      },
    },
  )
}
