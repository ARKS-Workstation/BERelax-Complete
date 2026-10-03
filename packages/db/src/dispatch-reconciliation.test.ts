import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DISPATCH_RECONCILIATION_SQLSTATE } from './repositories/dispatch-reconciliation.ts'

/**
 * Migration 0138's structural claims, read off the SQL (A-MEAS-07).
 *
 * `apps/worker/src/jobs/dispatch-reconciliation.itest.ts` proves the refusals FIRE against a real
 * PostgreSQL. It cannot prove they are still DECLARED: a trigger deleted from the migration is invisible to
 * a database that already has it, so the suite stays green on a tree that no longer creates it and the next
 * person to build a database from `packages/db/migrations` gets a schema in which a summary may disagree
 * with its own items. `analytics-consent.test.ts` and `analytics-dispatch.test.ts` state the same reason
 * for 0125 and 0137.
 *
 * ## The most important line in this file
 *
 * ZY471 being DEFERRED. A constraint trigger that is not deferrable fires on the summary before any item
 * has been written, so every single write would be refused — which is loud, and would be fixed by removing
 * the trigger. The dangerous direction is the other one: `deferrable initially immediate` applies at the
 * statement, so the writer's own order would decide whether the rule held, and the rule would pass for
 * every write this pass makes and fail for the first caller that wrote its items first.
 */

const MIGRATION = 'packages/db/migrations/0138_dispatch_reconciliation.sql'
const MIRROR = 'packages/db/src/schema/analytics-dispatch.ts'

const sql = readFileSync(MIGRATION, 'utf8')
const mirror = readFileSync(MIRROR, 'utf8')

describe('migration 0138 declares the reconciliation and its refusals', () => {
  it('reads the migration at all', () => {
    // The control. Every assertion below is satisfied by an empty string, which is ADR 0002's subject.
    expect(sql.length).toBeGreaterThan(6_000)
    expect(sql).toContain('create table analytics_dispatch_reconciliation')
  })

  it('keys the summary and the items so a second run cannot ADD a row', () => {
    // The acceptance line "two runs produce identical rows" is a PRIMARY KEY here, not a convention.
    expect(sql).toContain('primary key (business_day, destination)')
    expect(sql).toContain('primary key (business_day, destination, event_id, classification)')
  })

  it('holds the state to the figures in both directions', () => {
    expect(sql).toContain('analytics_dispatch_reconciliation_state_follows_the_figures')
    // A bijection, so a row cannot say `reconciled` beside three missing items — and the suppression count
    // is deliberately NOT in the condition, because a consent suppression is the system working.
    expect(sql).toMatch(
      /\(state = 'unreconciled'\)\s*=\s*\(difference_fils <> 0 or missing_count > 0 or duplicate_count > 0\)/,
    )
    expect(sql).not.toMatch(/intentionally_not_pushed_count > 0\s*\)/)
  })

  it('ties each classification to the rows it may name', () => {
    expect(sql).toContain('analytics_dispatch_reconciliation_item_missing_has_no_row')
    expect(sql).toContain('analytics_dispatch_reconciliation_item_duplicate_has_two_rows')
    expect(sql).toContain('analytics_dispatch_recon_item_suppression_names_its_row')
    // Two DISTINCT rows for a duplicate. One id twice is one row reported as two, which is a second
    // conversion that does not exist.
    expect(sql).toContain('dispatch_id <> other_dispatch_id')
  })

  it('declares the three classifications and nothing else', () => {
    expect(sql).toMatch(
      /create type analytics_dispatch_difference_kind as enum\s*\(\s*'missing', 'duplicate', 'intentionally_not_pushed'\s*\)/,
    )
  })

  it('declares ZY471 as a DEFERRED constraint trigger on BOTH tables', () => {
    expect(sql).toContain('create function assert_reconciliation_agrees_with_its_items()')
    expect(sql).toContain(
      `errcode = '${DISPATCH_RECONCILIATION_SQLSTATE.summaryDisagreesWithItems}'`,
    )
    // Both ends of the write, because an item inserted alone is the same disagreement arriving from the
    // other side — and `deferrable initially deferred` on both, which is the line this file exists for.
    for (const trigger of [
      'analytics_dispatch_reconciliation_agrees',
      'analytics_dispatch_reconciliation_item_agrees',
    ]) {
      const at = sql.indexOf(`create constraint trigger ${trigger}`)
      expect(at, `${trigger} must be declared`).toBeGreaterThan(-1)
      const statement = sql.slice(at, sql.indexOf(';', at))
      expect(statement).toContain('deferrable initially deferred')
      expect(statement).toContain('after insert or update or delete')
    }
  })

  it('declares ZY472 on the write, before the row lands', () => {
    expect(sql).toContain('create function assert_reconciled_day_has_closed()')
    expect(sql).toContain(`errcode = '${DISPATCH_RECONCILIATION_SQLSTATE.dayHasNotClosed}'`)
    const at = sql.indexOf('create trigger analytics_dispatch_reconciliation_day_has_closed')
    expect(at).toBeGreaterThan(-1)
    expect(sql.slice(at, sql.indexOf(';', at))).toContain('before insert or update')
    // It reads the trading calendar, which is what no CHECK may do and why this is a trigger at all.
    expect(sql).toContain('from business_day')
  })

  it('brings the pass its own agent AND a heartbeat row', () => {
    expect(sql).toContain('insert into agent_definition')
    expect(sql).toContain(
      "insert into agent_heartbeat (agent_key)\nvalues ('dispatch_reconciliation')",
    )
    // Its own and not a shared one, because a reconciliation nobody ran looks exactly like one that found
    // nothing — which is the pair only a heartbeat can tell apart.
    expect(sql).toContain("('dispatch_reconciliation', 'Dispatch reconciliation'")
  })

  it('does NOT touch the dispatch queue or its gate', () => {
    // A-MEAS-07 reads what was pushed and may not change it: ZY451 freezes a transmitted row precisely so
    // that the pushed side of this comparison cannot be edited to agree with the other side.
    expect(sql).not.toContain('alter table analytics_dispatch ')
    expect(sql).not.toContain('drop trigger analytics_dispatch_transmission_is_frozen')
    expect(sql).not.toContain('create function dispatch_consent_gap')
  })
})

describe('the Drizzle mirror carries 0138', () => {
  it('states both tables, the enum and the three item CHECKs', () => {
    expect(mirror).toContain("pgEnum('analytics_dispatch_difference_kind'")
    expect(mirror).toContain("pgTable(\n  'analytics_dispatch_reconciliation'")
    expect(mirror).toContain("pgTable(\n  'analytics_dispatch_reconciliation_item'")
    for (const name of [
      'analytics_dispatch_reconciliation_item_missing_has_no_row',
      'analytics_dispatch_reconciliation_item_duplicate_has_two_rows',
      'analytics_dispatch_recon_item_suppression_names_its_row',
      'analytics_dispatch_reconciliation_state_follows_the_figures',
    ]) {
      expect(mirror, `the mirror must carry ${name}`).toContain(name)
    }
  })
})
