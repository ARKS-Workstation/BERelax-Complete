import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Sql } from './connection.ts'
import {
  ANALYTICS_DISPATCH_SQLSTATE,
  dueAnalyticsDispatches,
} from './repositories/analytics-dispatch.ts'

/**
 * Migration 0137's structural claims, read off the SQL, and the reader's two refusals (A-MEAS-03).
 *
 * ## Why a static test beside the integration one
 *
 * `packages/fixtures/src/analytics-dispatch.itest.ts` proves the refusals FIRE against a real PostgreSQL,
 * which is the claim that matters. It cannot prove they are still DECLARED: a trigger deleted from the
 * migration is invisible to a database that already has it, so the suite stays green on a tree that no
 * longer creates it and the next person to build a database from `packages/db/migrations` gets a schema
 * with no idempotency index and no frozen transmission in it. `analytics-consent.test.ts` is this file's
 * nearest relative and states the same reason for 0125.
 *
 * ## The most important line in this file
 *
 * The unique index having no `where` clause. Every other assertion here is about something failing loudly;
 * that one is about the direction the system fails in when nothing fails at all. A partial index — the
 * version that gets written, because a `suppressed` row looks like a row that should not block anything —
 * admits a second dispatch for a conversion whose first answer was "this visitor said no", and the two
 * rows are then two answers to whether that push was permitted. Nothing errors, and A-MEAS-07 reports a
 * duplicate it cannot attribute.
 */

const MIGRATION = 'packages/db/migrations/0137_analytics_dispatch_transport.sql'
const MIRROR = 'packages/db/src/schema/analytics-dispatch.ts'

const sql = readFileSync(MIGRATION, 'utf8')
const mirror = readFileSync(MIRROR, 'utf8')

/** A connection nothing may reach. Every case below refuses BEFORE a statement is issued. */
const unreachable = (() => {
  const refuse = () => {
    throw new Error(
      'dueAnalyticsDispatches issued a statement for an input it was supposed to refuse, so the ' +
        'refusal happens after the round trip rather than instead of it.',
    )
  }
  return refuse as unknown as Sql
})()

describe('migration 0137 declares the transport half', () => {
  it('reads the migration at all', () => {
    // The control. Every assertion below is satisfied by an empty string, which is ADR 0002's subject.
    expect(sql.length).toBeGreaterThan(8_000)
    expect(sql).toContain('alter table analytics_dispatch')
  })

  it('adds the five columns with a producer, and event_id NOT NULL', () => {
    for (const column of ['event_id', 'payload', 'action_source', 'occurred_at', 'attempts']) {
      expect(sql, `0137 must add ${column}`).toContain(`add column ${column}`)
    }
    // NOT NULL and no default. A nullable event id is not a smaller claim: two NULLs are DISTINCT to a
    // unique index, so the idempotency index would silently stop being one.
    expect(sql).toMatch(/add column event_id\s+text\s+not null/)
    expect(sql).not.toMatch(/add column event_id[^,]*default/)
  })

  it('declares the idempotency index over EVERY state, with no where clause', () => {
    const index =
      /create unique index analytics_dispatch_event_destination_unique\s+on analytics_dispatch \(event_id, destination\);/
    expect(sql).toMatch(index)
    // The line this file exists for. A partial index is the version that gets written.
    const statement = sql.slice(
      sql.indexOf('create unique index analytics_dispatch_event_destination_unique'),
    )
    expect(statement.slice(0, statement.indexOf(';'))).not.toContain('where')
  })

  it('relaxes exactly the three constraints 0125 asked it to, and adds the third sibling', () => {
    expect(sql).toContain('drop constraint analytics_dispatch_reason_known')
    expect(sql).toContain("'consent_denied', 'consent_withdrawn', 'transport_failed'")
    expect(sql).toContain('drop constraint analytics_dispatch_reason_iff_refused')
    expect(sql).toContain('analytics_dispatch_failure_is_a_transport_failure')
    // The two 0125 siblings are KEPT. A dropped one would make a suppression able to carry any reason.
    expect(sql).not.toContain('drop constraint analytics_dispatch_suppression_is_a_denial')
    expect(sql).not.toContain('drop constraint analytics_dispatch_cancellation_is_a_withdrawal')
  })

  it('refuses a conversion judged before it happened, which is also what refuses a future instant', () => {
    expect(sql).toContain('analytics_dispatch_occurred_before_decided')
    expect(sql).toMatch(/check \(occurred_at <= decided_at\)/)
  })

  it('ties an outcome to an attempt and a failure to its error', () => {
    expect(sql).toContain('analytics_dispatch_outcome_had_an_attempt')
    expect(sql).toContain('analytics_dispatch_failure_carries_its_error')
  })

  it('declares both triggers, both BEFORE UPDATE, with their own codes', () => {
    expect(sql).toContain('create function refuse_transmitted_dispatch_change()')
    expect(sql).toContain(
      'create trigger analytics_dispatch_transmission_is_frozen\n  before update',
    )
    expect(sql).toContain(`errcode = '${ANALYTICS_DISPATCH_SQLSTATE.transmissionIsFrozen}'`)
    expect(sql).toContain('create function assert_dispatch_attempts_monotonic()')
    expect(sql).toContain(
      'create trigger analytics_dispatch_attempts_only_increase\n  before update',
    )
    expect(sql).toContain(`errcode = '${ANALYTICS_DISPATCH_SQLSTATE.attemptsAreMonotonic}'`)
  })

  it('does NOT touch the consent gate, which is the whole of ADR 0091', () => {
    // A second consent check is the defect A-MEAS-02 was built to prevent. This migration may not
    // re-create, drop or replace either half of 0125's gate.
    expect(sql).not.toContain('create function dispatch_consent_gap')
    expect(sql).not.toContain('create or replace function dispatch_consent_gap')
    expect(sql).not.toContain('drop trigger analytics_dispatch_consent_gate')
    expect(sql).not.toContain('create function assert_dispatch_consent')
  })

  it('brings the agent definition AND its heartbeat row, which is 0031 restated twice', () => {
    expect(sql).toContain('insert into agent_definition')
    expect(sql).toContain("insert into agent_heartbeat (agent_key)\nvalues ('analytics_dispatch')")
    // 0107 shipped `gratuity_accrual` without the heartbeat and nothing caught it until a suite read the
    // table, because `agentsWithHeartbeat` INNER JOINS the two: a definition with no heartbeat row is an
    // agent the watchdog cannot see at all.
  })

  it('adds the enum label OUTSIDE the transaction, because the block below uses it', () => {
    const label = sql.indexOf(
      "alter type analytics_dispatch_state add value if not exists 'failed'",
    )
    const begin = sql.indexOf('\nbegin;')
    expect(label).toBeGreaterThan(-1)
    expect(begin).toBeGreaterThan(label)
  })
})

describe('the Drizzle mirror carries what the migration added', () => {
  it('states the fifth state, the five columns and the unique index', () => {
    expect(mirror).toContain("'failed',")
    for (const field of [
      'eventId',
      'payload',
      'actionSource',
      'occurredAt',
      'attempts',
      'lastError',
    ]) {
      expect(mirror, `the mirror must carry ${field}`).toContain(field)
    }
    expect(mirror).toContain("uniqueIndex('analytics_dispatch_event_destination_unique')")
  })
})

describe('the reader refuses an input it cannot honour', () => {
  it('refuses an empty backoff ladder rather than treating it as retry-immediately', async () => {
    // An empty array makes every failed row due on EVERY pass, which is the hammering a backoff exists to
    // prevent — and an empty array is exactly what a mis-wired caller passes.
    await expect(
      dueAnalyticsDispatches(unreachable, {
        nowIso: '2026-10-02T09:00:00.000Z',
        backoffSeconds: [],
        limit: 10,
      }),
    ).rejects.toThrow(/empty backoff ladder/)
  })

  it('refuses a limit of zero, which drains nothing and reports a clean pass', async () => {
    // ADR 0002's failure in a queue: a pass over nothing answering "all sent".
    for (const limit of [0, -1, 1.5]) {
      await expect(
        dueAnalyticsDispatches(unreachable, {
          nowIso: '2026-10-02T09:00:00.000Z',
          backoffSeconds: [30],
          limit,
        }),
      ).rejects.toThrow(/limit of/)
    }
  })

  it('accepts a ladder and a limit that are usable, so the refusals are about the input', async () => {
    // The control. Both cases above are satisfied by a function that throws for everything, and this one
    // proves the refusals are not that: a usable input gets past them and reaches the connection, which
    // this stub refuses to be.
    await expect(
      dueAnalyticsDispatches(unreachable, {
        nowIso: '2026-10-02T09:00:00.000Z',
        backoffSeconds: [30],
        limit: 10,
      }),
    ).rejects.toThrow(/issued a statement/)
  })
})
