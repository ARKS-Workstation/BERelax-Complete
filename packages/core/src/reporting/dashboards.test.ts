import { describe, expect, it } from 'vitest'
import { can, canReadFieldGroup, ROLES, type Role } from '../access/permissions.ts'
import {
  assertDashboards,
  bucketsAreContiguous,
  DASHBOARD_COLUMN_GROUPS,
  DASHBOARD_COLUMNS,
  DASHBOARD_FOR_ROLE,
  DASHBOARD_LAYOUT,
  DASHBOARD_RULES,
  DASHBOARD_TILES,
  type DashboardTile,
  dashboardFindings,
  dashboardScopeFor,
  forbiddenColumnsFor,
  mayReadTile,
  resolveDashboardTile,
  selectableColumnsFor,
  tilesFor,
  tradingDayBuckets,
} from './dashboards.ts'
import { KPI_REGISTRY } from './kpi-registry.ts'

/**
 * R-REP-08 — the role-scoped dashboards, as declarations.
 *
 * The claims here are the ones that are about the MATRIX rather than about a query:
 *
 *   * **Deny by default, over every role in F07.** Not a sample of three: the assertion is a walk over
 *     `ROLES`, so a role added to the matrix is covered on the commit that adds it.
 *   * **A forbidden column is absent from the projection**, which is the half that can be made without a
 *     database — `apps/web/src/dashboards.itest.ts` makes the stronger one, that it is absent from the
 *     serialised payload of a real query.
 *   * **The trading window is derived**, so a day with an override produces a different number of buckets
 *     and the standard day produces the fifteen the acceptance line names.
 *   * **Each rule has been seen to fire**, over declarations handed in rather than the shipped ones.
 */

describe('the shipped declarations', () => {
  it('are sound, and every rule name is distinct', () => {
    expect(() => assertDashboards()).not.toThrow()
    expect(dashboardFindings()).toEqual([])
    expect(new Set(DASHBOARD_RULES).size).toBe(DASHBOARD_RULES.length)
  })

  it('names a registered measure on every tile, which is what makes a drill-down equal it', () => {
    for (const tile of DASHBOARD_TILES) {
      const measure = KPI_REGISTRY.measuresById.get(tile.measureId)
      expect(measure, `${tile.tileId} names no registered measure`).toBeDefined()
      // And the declaration the drill-down is built from is non-empty, so there is something to read.
      expect(measure?.reads.length).toBeGreaterThan(0)
    }
    expect(DASHBOARD_TILES.length).toBeGreaterThan(2)
  })

  it('publishes only registered tiles on every dashboard', () => {
    const registered = new Set(DASHBOARD_TILES.map((tile) => tile.tileId))
    for (const [dashboard, published] of Object.entries(DASHBOARD_LAYOUT)) {
      for (const tileId of published) {
        expect(registered.has(tileId), `${dashboard} publishes "${tileId}"`).toBe(true)
      }
      expect(published.length, `${dashboard} publishes nothing`).toBeGreaterThan(0)
    }
  })

  it('resolves a registered tile and refuses a name nothing publishes', () => {
    expect(resolveDashboardTile('net_revenue').requires).toBe('report:financial')
    expect(() => resolveDashboardTile('net_revenues')).toThrow(/No dashboard tile/)
  })
})

describe('deny by default, over every role in the matrix', () => {
  it('maps every role to a dashboard or to nothing, with no fall-through', () => {
    for (const role of ROLES) {
      expect(Object.hasOwn(DASHBOARD_FOR_ROLE, role), `${role} has no entry`).toBe(true)
    }
    // The control: at least one role really gets nothing, so the `null` branch is exercised.
    expect(ROLES.some((role) => DASHBOARD_FOR_ROLE[role] === null)).toBe(true)
  })

  it('gives a role no tile it lacks the permission for', () => {
    for (const role of ROLES) {
      for (const tile of tilesFor(role)) {
        expect(can(role, tile.requires), `${role} was given ${tile.tileId}`).toBe(true)
        for (const group of tile.fieldGroups) {
          expect(canReadFieldGroup(role, group), `${role} was given ${tile.tileId}`).toBe(true)
        }
      }
    }
  })

  it('refuses the therapist the business-wide P&L tile and gives it to the accountant', () => {
    // The acceptance line, as the matrix answers it before any request is made.
    expect(mayReadTile('therapist', 'net_revenue')).toBe(false)
    expect(mayReadTile('accountant', 'net_revenue')).toBe(true)
    expect(mayReadTile('owner', 'net_revenue')).toBe(true)
    // And the therapist is not simply refused everything, or the assertion above would hold for a
    // dashboard that showed nothing at all.
    expect(mayReadTile('therapist', 'treatment_minutes')).toBe(true)
  })

  it('gives a role with no dashboard no tiles at all', () => {
    for (const role of ROLES) {
      if (DASHBOARD_FOR_ROLE[role] !== null) continue
      expect(tilesFor(role), `${role} has no dashboard and yet got tiles`).toEqual([])
    }
  })

  it('refuses a business-wide tile to a scoped role even where the permission would allow it', () => {
    // The third refusal, and the one a permission check alone would miss. `occupied_room_minutes` needs
    // only `report:read`, which the therapist holds — it is removed because it is business-wide.
    expect(can('therapist', 'report:read')).toBe(false)
    const scopedBusinessWide = tilesFor('therapist').filter((tile) => tile.businessWide)
    expect(scopedBusinessWide).toEqual([])
  })
})

describe('the scope is a value the query takes', () => {
  it('scopes the therapist to their own employee id and nobody else', () => {
    expect(dashboardScopeFor('therapist', 'employee-1')).toEqual({
      kind: 'own_employee',
      employeeId: 'employee-1',
    })
    for (const role of ROLES) {
      if (role === 'therapist') continue
      expect(dashboardScopeFor(role, 'employee-1').kind, role).toBe('business')
    }
  })

  it('refuses an empty employee id rather than restricting on nothing', () => {
    // An empty id in a `where employee_id = ''` matches no row, and in a template that interpolates it
    // into an optional clause it matches EVERY row. Refusing it is the only answer that cannot be the
    // whole business under a per-person label.
    expect(() => dashboardScopeFor('therapist', '  ')).toThrow(/employee id/)
  })
})

describe('a forbidden column is absent from the projection', () => {
  it('never selects a wage or a clinical note for a role that may not read one', () => {
    for (const role of ROLES) {
      const selectable = selectableColumnsFor(role)
      if (!canReadFieldGroup(role, 'employee.salary')) {
        expect(selectable, `${role}`).not.toContain('employee_wage_fils')
      }
      if (!canReadFieldGroup(role, 'clinical.notes')) {
        expect(selectable, `${role}`).not.toContain('clinical_note')
      }
      // The operational columns are granted to everybody who has a tile, or a drill-down could not
      // identify its own rows.
      expect(selectable).toContain('business_day')
      expect(selectable).toContain('amount')
    }
  })

  it('refuses a column nobody classified, to everybody including the owner', () => {
    // The CLOSED default, exercised rather than declared. The shipped classification has no unclassified
    // column, so this is the only way the branch can be reached — and it had to be reachable: a rule
    // over an unreachable branch is a rule that cannot fire, which gate case 199d found.
    const withMystery = { ...DASHBOARD_COLUMN_GROUPS, mystery_column: undefined }
    expect(selectableColumnsFor('owner', withMystery)).not.toContain('mystery_column')
    expect(forbiddenColumnsFor('owner', withMystery)).toContain('mystery_column')
    // And the control: the classified columns are still granted, so the refusal is about the missing
    // classification rather than about the map having been replaced.
    expect(selectableColumnsFor('owner', withMystery)).toContain('employee_wage_fils')
  })

  it('names what each role is refused, and the two lists partition the columns', () => {
    for (const role of ROLES) {
      const allowed = selectableColumnsFor(role)
      const forbidden = forbiddenColumnsFor(role)
      expect([...allowed, ...forbidden].sort()).toEqual([...DASHBOARD_COLUMNS].sort())
      expect(allowed.filter((column) => forbidden.includes(column))).toEqual([])
    }
    // The controls: somebody is refused something, and the owner is refused nothing.
    expect(forbiddenColumnsFor('therapist').length).toBeGreaterThan(0)
    expect(forbiddenColumnsFor('owner')).toEqual([])
    // The accountant gets financials and is refused every clinical field — the acceptance line.
    expect(selectableColumnsFor('accountant')).toContain('customer_spend_fils')
    expect(forbiddenColumnsFor('accountant')).toContain('clinical_note')
  })
})

describe('the trading window as buckets', () => {
  it('is fifteen contiguous hours in business-day order for the standard day', () => {
    const buckets = tradingDayBuckets({ opensAtHour: 11, openMinutes: 15 * 60 })
    expect(buckets.length).toBe(15)
    expect(bucketsAreContiguous(buckets)).toBe(true)
    expect(buckets.map((bucket) => bucket.startHour)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1,
    ])
    // Business-day order, which is the whole point: a sort by the clock would put 00:00 and 01:00 — two
    // of the busiest hours — at the start of the chart.
    expect(buckets[0]?.label).toBe('11:00')
    expect(buckets[14]?.label).toBe('01:00')
  })

  it('follows the day rather than a literal, so an override changes the answer', () => {
    // A Ramadan schedule, or any dated `premises_hours_override`: a shorter day is fewer buckets. A
    // window spelled in the module would be wrong on exactly these days.
    expect(tradingDayBuckets({ opensAtHour: 20, openMinutes: 6 * 60 }).length).toBe(6)
    expect(tradingDayBuckets({ opensAtHour: 20, openMinutes: 6 * 60 })[5]?.label).toBe('01:00')
  })

  it('rounds a part hour UP, so no takings fall outside the chart', () => {
    const buckets = tradingDayBuckets({ opensAtHour: 11, openMinutes: 14 * 60 + 40 })
    expect(buckets.length).toBe(15)
    expect(bucketsAreContiguous(buckets)).toBe(true)
  })

  it('refuses a window that is not one', () => {
    expect(() => tradingDayBuckets({ opensAtHour: 11, openMinutes: 0 })).toThrow(/positive/)
    expect(() => tradingDayBuckets({ opensAtHour: 24, openMinutes: 60 })).toThrow(
      /hour of the clock/,
    )
  })

  it('reports a non-contiguous list as non-contiguous, which is the detector’s control', () => {
    const buckets = tradingDayBuckets({ opensAtHour: 11, openMinutes: 3 * 60 })
    const gapped = [buckets[0], buckets[2]].filter((bucket) => bucket !== undefined)
    expect(bucketsAreContiguous(gapped)).toBe(false)
    expect(bucketsAreContiguous(buckets)).toBe(true)
  })
})

describe('each rule has been seen to fire', () => {
  const withTile = (tileId: string, patch: Partial<DashboardTile>) =>
    DASHBOARD_TILES.map((tile) => (tile.tileId === tileId ? { ...tile, ...patch } : tile))

  const rulesFrom = (options: Parameters<typeof dashboardFindings>[0]): readonly string[] =>
    dashboardFindings(options).map((finding) => finding.rule)

  it('reports a role with no entry at all', () => {
    const { therapist: _dropped, ...rest } = DASHBOARD_FOR_ROLE
    expect(rulesFrom({ forRole: rest as Readonly<Record<Role, 'owner' | null>> })).toContain(
      'every-role-is-mapped-to-a-dashboard-or-to-nothing',
    )
  })

  it('reports a tile naming a measure the registry does not hold', () => {
    expect(
      rulesFrom({ tiles: withTile('net_revenue', { measureId: 'net_revenue_fils' }) }),
    ).toContain('tile-names-a-registered-measure')
  })

  it('reports a tile with no row grain', () => {
    expect(rulesFrom({ tiles: withTile('net_revenue', { rowGrain: '  ' }) })).toContain(
      'tile-states-its-row-grain',
    )
  })

  it('reports a layout publishing a tile nothing defines', () => {
    expect(
      rulesFrom({
        layout: { ...DASHBOARD_LAYOUT, accountant: ['gross_revenue'] },
      }),
    ).toContain('published-tile-is-registered')
  })

  it('reports an empty column classification', () => {
    expect(rulesFrom({ columnGroups: {} })).toContain('every-selectable-column-is-classified')
  })

  it('reports a scoped dashboard PUBLISHING a business-wide tile', () => {
    // Two mutations, both of which `tilesFor` would silently absorb — which is why the rule reads the
    // LAYOUT. A rule over `tilesFor` would be checking the post-condition of that function's own filter
    // and could never fire; the first version of this rule did exactly that, and this test is what
    // found it.
    expect(rulesFrom({ tiles: withTile('treatment_minutes', { businessWide: true }) })).toContain(
      'a-scoped-role-publishes-no-business-wide-tile',
    )
    expect(
      rulesFrom({
        layout: { ...DASHBOARD_LAYOUT, therapist: ['treatment_minutes', 'net_revenue'] },
      }),
    ).toContain('a-scoped-role-publishes-no-business-wide-tile')
    // And the control: the shipped declarations do not fire it, and the runtime refusal holds anyway.
    expect(rulesFrom({})).not.toContain('a-scoped-role-publishes-no-business-wide-tile')
    expect(tilesFor('therapist').filter((tile) => tile.businessWide)).toEqual([])
  })

  it('refuses a tile whose PERMISSION the role lacks, through tilesFor itself', () => {
    // The permission half of the tile grant, exercised rather than declared. Every shipped tile's
    // permission is already held by every role its dashboard publishes it to, so removing the `can()`
    // call changed nothing and the grant looked tested while being dead — which gate case 199c found.
    const patched = withTile('rostered_minutes', { requires: 'report:financial' })
    const options = { tiles: patched, layout: DASHBOARD_LAYOUT, forRole: DASHBOARD_FOR_ROLE }
    expect(can('therapist', 'report:financial')).toBe(false)
    expect(tilesFor('therapist', options).map((tile) => tile.tileId)).not.toContain(
      'rostered_minutes',
    )
    // The owner is the control: a refusal that removed the tile from everybody would pass on its own.
    expect(tilesFor('owner', options).map((tile) => tile.tileId)).toContain('rostered_minutes')
  })

  it('refuses a tile whose field group the role lacks, through tilesFor itself', () => {
    // The field-group half of the tile grant, exercised rather than declared. `employee.salary` is the
    // one group the manager is deliberately refused (P-HR-01), so a tile requiring it drops off the
    // manager's dashboard while staying on the owner's — and the owner is the control, because a
    // refusal that removed the tile from everybody would pass the first assertion on its own.
    const patched = withTile('rostered_minutes', { fieldGroups: ['employee.salary'] })
    const options = { tiles: patched, layout: DASHBOARD_LAYOUT, forRole: DASHBOARD_FOR_ROLE }
    expect(tilesFor('manager', options).map((tile) => tile.tileId)).not.toContain(
      'rostered_minutes',
    )
    expect(tilesFor('owner', options).map((tile) => tile.tileId)).toContain('rostered_minutes')
    expect(canReadFieldGroup('manager', 'employee.salary')).toBe(false)
  })

  it('throws naming the rules that fired', () => {
    expect(() => assertDashboards({ columnGroups: {} })).toThrow(
      /every-selectable-column-is-classified/,
    )
  })
})
