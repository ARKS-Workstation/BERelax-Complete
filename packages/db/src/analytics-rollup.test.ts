import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ROLLUP_SQLSTATE, rollupRefusalOf } from './repositories/analytics-rollup.ts'

/**
 * Migration 0150's structural claims, read off the SQL (A-FIRST-09).
 *
 * ## Why a static test beside the integration one
 *
 * `rollup.itest.ts` proves the refusals FIRE against a real PostgreSQL. It cannot prove they are still
 * DECLARED: a trigger deleted from the migration is invisible to a database that already has it, so the
 * suite stays green on a tree that no longer creates it and the next person to build a database from
 * `packages/db/migrations` gets a schema where a session can reach one funnel step twice and a half-open
 * day can be rolled up as a whole one. `analytics-dispatch.test.ts` states the same reason for 0137.
 *
 * ## The two assertions here that are not about a refusal
 *
 * The ABSENCE of a second trading-date resolver, and the two columns the gap cohort is counted in. Both
 * are about a figure that would be wrong without anything failing: a third statement of "which trading
 * date does this instant belong to" disagrees with the two the database already enforces on exactly the
 * dates somebody overrode the hours for, and a rollup with no gap count reads nine hours of daytime
 * browsing as trade.
 */

const MIGRATION = 'packages/db/migrations/0150_analytics_rollups.sql'
const MIRROR = 'packages/db/src/schema/analytics.ts'
const WRITER = 'packages/db/src/repositories/analytics-rollup.ts'
const PASS = 'apps/worker/src/jobs/analytics-rollup.ts'

const sql = readFileSync(MIGRATION, 'utf8')
const mirror = readFileSync(MIRROR, 'utf8')
const writer = readFileSync(WRITER, 'utf8')
const pass = readFileSync(PASS, 'utf8')

describe('the two refusals are declared', () => {
  it('refuses a session reaching one funnel step twice (ZY701)', () => {
    expect(sql).toContain('create function analytics.assert_one_step_per_session()')
    expect(sql).toContain("using errcode = 'ZY701'")
    // BEFORE INSERT OR UPDATE, and on the partitioned PARENT so PostgreSQL clones it onto every
    // partition: a trigger on one month's partition would be silent for every other month.
    expect(sql).toContain(
      'create trigger funnel_step_one_per_session\n  before insert or update on analytics.funnel_step',
    )
    // The row being written is excluded from its own lookup, or an UPDATE would always find itself.
    expect(sql).toContain('and f.funnel_step_id <> new.funnel_step_id')
    expect(rollupRefusalOf({ code: ROLLUP_SQLSTATE.oneStepPerSession })).toBe(
      'one_step_per_session',
    )
  })

  it('refuses a rollup for a day that has not closed, on all three tables (ZY702)', () => {
    expect(sql).toContain('create function analytics.assert_rolled_up_day_has_closed()')
    expect(sql).toContain("using errcode = 'ZY702'")
    // `clock_timestamp()` and not `now()`: `now()` is the TRANSACTION's start, and a long backfill would
    // judge every day it touched against the instant the backfill began.
    expect(sql).toContain('if clock_timestamp() >= v_closes_at then')
    // Three triggers and not one shared claim: three narrow rules fail by name, and a rule declared on
    // one table says nothing about the other two.
    for (const table of ['daily_traffic', 'daily_funnel', 'daily_source_revenue']) {
      expect(sql).toContain(`before insert or update on analytics.${table}`)
    }
    expect(rollupRefusalOf({ code: ROLLUP_SQLSTATE.dayHasNotClosed })).toBe('day_has_not_closed')
  })
})

describe('the gap cohort', () => {
  it('is counted in two columns, each bounded by its own total', () => {
    expect(sql).toContain('add column gap_sessions integer not null default 0')
    expect(sql).toContain('add column gap_entered integer not null default 0')
    // Bounded, for `daily_traffic_bots_within_sessions`' reason: a row claiming more gap traffic than
    // traffic would render a percentage over 100 and nothing else would notice.
    expect(sql).toContain('check (gap_sessions >= 0 and gap_sessions <= sessions)')
    expect(sql).toContain('check (gap_entered >= 0 and gap_entered <= entered)')
    expect(mirror).toContain("gapSessions: integer('gap_sessions')")
    expect(mirror).toContain("gapEntered: integer('gap_entered')")
  })

  it('is read off the basis 0116 stored, never re-resolved', () => {
    // The assertion about the thing that would not fail loudly. A third statement of the rule would look
    // like an improvement and disagree with the two the database enforces on exactly the dates somebody
    // overrode the hours for — the days it matters most (ADR 0066).
    expect(sql).not.toMatch(/create\s+function\s+analytics\.rollup_trading_date/i)
    // All THREE readers — the counting query, the traffic rollup and the funnel rollup — read the stored
    // basis. Asserting one occurrence would let the other two be rewritten to `false`, and the figure
    // would then be zero for ever: a column whose producer stopped working, which is 0125's own rule.
    expect(writer.match(/s\.trading_date_basis <> 'trading'/g) ?? []).toHaveLength(3)
    // And every rollup GROUPS on a stored, enforced trading date rather than on a truncated instant:
    // `analytics.session.trading_date` (ZY222) for traffic and the funnel, `appointment.trading_date`
    // (a foreign key into business_day) for revenue.
    expect(writer).toContain(
      'group by s.trading_date, a.source, a.medium, a.campaign, s.device_kind',
    )
    expect(writer).toContain('group by s.trading_date, f.step, a.source, a.medium, a.campaign')
    expect(writer).toContain('group by d.trading_date, d.source, d.medium, d.campaign')
  })

  it('does not reach daily_source_revenue, because an appointment is always on a trading date', () => {
    // `appointment.trading_date` is materialised at booking and carries a real foreign key into
    // `business_day` (0024), so the gap cannot arise there — and a column that is zero for ever is
    // indistinguishable from a column whose producer stopped working (0125's rule).
    expect(sql).not.toContain('alter table analytics.daily_source_revenue\n  add column gap_')
    expect(writer).toContain('a.trading_date = ')
  })
})

describe('what the pass is permitted to do, and what it reads from elsewhere', () => {
  it('gains DELETE on funnel_step alone, so a re-materialisation is expressible', () => {
    expect(sql).toContain('grant delete on analytics.funnel_step to berelax_app')
    // And nothing else in that schema. 0096's rule — rows leave `analytics` through
    // `analytics.run_retention` and nothing else — stands for the raw tables, and `analytics.event`
    // keeps its ZY065 refusal for every role but `berelax_retention`.
    expect(sql).not.toMatch(/grant\s+[^;]*delete[^;]*on\s+analytics\.event/i)
    // The keyword is asserted by a pattern and the table by its tail, deliberately: a literal starting
    // `delete from <table>` with no predicate is read as a STATEMENT by `seeded-row-deletes.test.ts`'s
    // scan (ADR 0050), and a prose assertion about somebody else's statement would be reported as this
    // file deleting rows it did not create.
    expect(writer).toMatch(/\bdelete\s+from analytics\.funnel_step f/)
    expect(writer).toContain('from analytics.funnel_step f')
  })

  it('gains DELETE on whatsapp_ref for the purge A-FIRST-07 handed it', () => {
    expect(sql).toContain('grant delete on whatsapp_ref to berelax_app')
    expect(writer).toMatch(/\bdelete\s+from whatsapp_ref r/)
    expect(writer).toContain('r.expires_at <')
  })

  it('reads the terminal stage from the LEDGER and nowhere else', () => {
    /*
     * `outstanding_fils <= 0` is the same quantity ZT001 refuses to let go negative, so this read and the
     * till cannot disagree about whether a document is settled. A funnel that counted its own idea of
     * paid would disagree with the invoice the moment a refund landed.
     *
     * All THREE readers are counted — the `paid` funnel step, the revenue rollup and A-MEAS-07's internal
     * side — because asserting one occurrence would let the other two be widened to `where true`, and a
     * funnel that counted unsettled documents as conversions is the figure this whole claim is about.
     */
    expect(writer.match(/st\.outstanding_fils <= 0/g) ?? []).toHaveLength(3)
    expect(writer).toContain('join invoice_settlement st')
  })

  it('replaces each rollup rather than accumulating onto it', () => {
    // One delete per rollup, and all three counted: a second run without one doubles every figure on
    // that table and nothing errors. The delete is also what removes an origination tuple a recompute no
    // longer produces — a renamed campaign would otherwise sit there for ever at its old count.
    expect(writer.match(/\bdelete\s+from analytics\.daily_/g) ?? []).toHaveLength(3)
    for (const relation of ['daily_traffic', 'daily_funnel', 'daily_source_revenue']) {
      expect(writer, relation).toContain(`from analytics.${relation} where trading_date`)
    }
  })

  it('takes both funnel mappings from @berelax/core rather than restating them in SQL', () => {
    expect(pass).toContain('COLLECTED_EVENT_FUNNEL')
    expect(pass).toContain('APPOINTMENT_STATUS_FUNNEL')
    // The repository holds no event name and no appointment status of its own: a copy in SQL would be
    // the second statement of the funnel that A-FIRST-02's `Record<AnalyticsEventName, …>` exists to
    // make impossible, and the drift would be an event collected and never counted.
    for (const name of ['page_view', 'service_viewed', 'cta_click', 'no_show', 'checked_in']) {
      expect(writer, `${name} must not be a literal in packages/db`).not.toContain(`'${name}'`)
    }
  })

  it('rolls up before A-MEAS-05 uploads and A-MEAS-07 reconciles', () => {
    // The ordering ADR 0093 states: the reconciliation's internal side is this pass's output, A-MEAS-05
    // uploads at 03:17 and A-MEAS-07 runs at 04:23, so this has to be earlier than both — and later than
    // 02:00, because ZY702 refuses a day that has not closed.
    expect(pass).toContain("cron: '35 2 * * *'")
    expect(pass).toContain('agent: ANALYTICS_ROLLUP_AGENT')
    expect(pass).toContain("export const ANALYTICS_ROLLUP_AGENT = 'nightly_rollups'")
  })
})
