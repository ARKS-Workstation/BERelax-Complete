import type { DashboardId, DashboardScope, GatedFigure, TradingBucket } from '@berelax/core'
import type { DashboardDrillDownRow, DashboardTimeOfDayRow, KpiInputRows } from '@berelax/db'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'

/**
 * The dashboard's view model (R-REP-08).
 *
 * A module of its own, and the reason is a `pnpm boundaries` failure rather than tidiness: the first
 * version had `render.ts` importing the payload type from `handler.ts` and `handler.ts` importing the
 * renderer from `render.ts`, which `no-circular` refuses. The admin estate's own arrangement is
 * `route.ts` + `handler.ts` + `render.ts` with the view model in `view.ts` — the five HR screens, the
 * quick-book screen and the pipeline board all record it — and this is what that arrangement is for.
 *
 * Types only. `view.ts` is a PAGE COMPONENT to `apps/web/src/kpi-arch.test.ts`, which refuses a value
 * imported from `@berelax/db` there: a row shape is a contract a renderer should be typed against and a
 * connection is not.
 */

/** The path, spelled once, so the registry entry, the drill-down links and the suites agree. */
export const DASHBOARD_PATH = '/reports'

/**
 * `ltr` or `rtl`. A LAYOUT axis and not a locale.
 *
 * The document is English in both directions, which is the arrangement the quick-book screen, the
 * pipeline board and the diary all record: a registry *document* must be served in both locales, and an
 * Arabic admin document needs the W-SYS-01 shell. `?dir=rtl` re-renders this English page mirrored, so
 * the direction half of the accessibility matrix is audited without inventing an Arabic admin surface.
 */
export type RenderDirection = 'ltr' | 'rtl'

export interface DashboardTileView {
  readonly tileId: string
  readonly label: string
  readonly measureId: string
  readonly rowGrain: string
  /** The figure, gated (ADR 0120). Only the `value` state carries one. */
  readonly figure: GatedFigure<string>
  readonly businessWide: boolean
}

/** Everything the HTML and the JSON share. Computed once, in `handler.ts`. */
export interface DashboardPayload {
  readonly dashboard: DashboardId
  readonly scope: DashboardScope
  readonly window: { readonly from: string; readonly to: string }
  readonly asOfIso: string
  readonly tiles: readonly DashboardTileView[]
  readonly buckets: readonly TradingBucket[]
  readonly timeOfDay: readonly DashboardTimeOfDayRow[]
  readonly bucketsAreContiguous: boolean
  /** The rows behind one tile, when one was asked for. */
  readonly drillDown: {
    readonly tileId: string
    readonly rowGrain: string
    readonly rows: readonly DashboardDrillDownRow[]
    /** `sum(amount)` over the rows, as a decimal string. The M5 identity's other side. */
    readonly aggregate: string
  } | null
  readonly columns: readonly string[]
  readonly provenance: KpiInputRows['provenance']
}

export interface DashboardView extends DashboardPayload {
  readonly chrome: AdminChrome
  readonly direction: RenderDirection
}
