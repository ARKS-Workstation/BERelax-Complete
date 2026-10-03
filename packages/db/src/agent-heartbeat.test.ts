import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ANALYTICS_DISPATCH_SQLSTATE } from './repositories/analytics-dispatch.ts'

/**
 * Migration 0151's structural claims, read off the SQL (A-MEAS-06).
 *
 * ## Why a static test beside the integration ones
 *
 * `apps/worker/src/jobs/agent-watchdog.itest.ts` proves the refusal FIRES and the four fields are
 * written; `apps/web/src/agent-console.itest.ts` proves the console can see a dead letter. Neither can
 * prove the rules are still DECLARED: a trigger deleted from the migration is invisible to a database
 * that already has it, so both suites stay green on a tree that no longer creates it and the next person
 * to build a database from `packages/db/migrations` gets a schema where a dead letter can be deleted and a
 * run can be recorded without saying when the next one is due.
 *
 * ## The assertion here that is not about a refusal
 *
 * `next_run_at` being derived from the agent's OWN `expected_interval_seconds` rather than from a cron
 * expression. The registry's expression and the declared interval are already held equal by `pnpm jobs`,
 * and a third derivation would be a third answer to when the next run is due — the one a console would
 * show while the watchdog doubled a different number.
 */

const MIGRATION = 'packages/db/migrations/0151_agent_heartbeat.sql'
const MIRROR = 'packages/db/src/schema/agents.ts'
const HEARTBEAT_WRITER = 'packages/db/src/repositories/agents.ts'
const DISPATCH_WRITER = 'packages/db/src/repositories/analytics-dispatch.ts'
const CONSUMER = 'apps/worker/src/jobs/analytics-dispatch.ts'
const CONSOLE = 'apps/web/app/(admin)/agents/queries.ts'
const WATCHDOG = 'apps/worker/src/jobs/agent-watchdog.ts'

const sql = readFileSync(MIGRATION, 'utf8')
const mirror = readFileSync(MIRROR, 'utf8')
const heartbeat = readFileSync(HEARTBEAT_WRITER, 'utf8')
const dispatch = readFileSync(DISPATCH_WRITER, 'utf8')
const consumer = readFileSync(CONSUMER, 'utf8')
const consoleModule = readFileSync(CONSOLE, 'utf8')
const watchdog = readFileSync(WATCHDOG, 'utf8')

describe('the fourth heartbeat field', () => {
  it('is paired to last_run_at in BOTH directions, so "on every run" is not a convention', () => {
    expect(sql).toContain('alter table agent_heartbeat add column next_run_at timestamptz')
    // `=` and not an implication. A one-sided rule would accept an attempt recorded with no next run,
    // which is the direction a writer actually forgets.
    expect(sql).toContain('check ((last_run_at is null) = (next_run_at is null))')
    expect(mirror).toContain("nextRunAt: timestamp('next_run_at', { withTimezone: true })")
  })

  it('is derived from the agent’s own declared interval, not from a cron expression', () => {
    // The same figure the watchdog doubles. A cron expression would be a third statement of when the next
    // run is due, and `pnpm jobs` already holds the registry's expression and this interval equal.
    expect(heartbeat).toContain('select d.expected_interval_seconds from agent_definition d')
    expect(heartbeat).toContain('next_run_at = ')
    // Written on the SAME statement as last_run_at, which is what the CHECK above requires of any writer.
    const statement = heartbeat.slice(heartbeat.indexOf('update agent_heartbeat'))
    const upTo = statement.slice(0, statement.indexOf('where agent_key'))
    expect(upTo).toContain('last_run_at = ')
    expect(upTo).toContain('next_run_at = ')
  })
})

describe('the dead letter', () => {
  it('is a STATE, declared with the three constraints that keep 0125’s bijection total', () => {
    expect(sql).toContain(
      "alter type analytics_dispatch_state add value if not exists 'dead_letter'",
    )
    // The bijection: a live row has no reason and every refused row has one. `dead_letter` joins the
    // refused side rather than being an exception to it.
    expect(sql).toContain(
      "check ((state in ('suppressed', 'cancelled_consent_withdrawn', 'failed', 'dead_letter'))\n         = (reason is not null))",
    )
    // A dead letter with no provider error is indistinguishable from a consumer that stopped running,
    // which is the whole shape of failure this table set exists to remove.
    expect(sql).toContain("check ((state = 'dead_letter') <= (last_error is not null))")
    // And one with no attempt behind it is a row somebody wrote by hand.
    expect(sql).toContain("check (state not in ('sent', 'failed', 'dead_letter') or attempts > 0)")
  })

  it('may not be deleted (ZY711), and the refusal is on DELETE', () => {
    expect(sql).toContain('create function refuse_dead_letter_delete()')
    expect(sql).toContain("using errcode = 'ZY711'")
    expect(sql).toContain(
      'create trigger analytics_dispatch_dead_letter_is_not_deletable\n  before delete on analytics_dispatch',
    )
    expect(ANALYTICS_DISPATCH_SQLSTATE.deadLetterIsNotDeletable).toBe('ZY711')
    // The rule is scoped to the STATE and not to the table: a `failed` row is still deletable, which is
    // what makes ZY711 a claim about a permanent failure rather than about `analytics_dispatch`.
    expect(sql).toContain("if old.state <> 'dead_letter' then")
    /*
     * And a CASCADE from `analytics.session` is permitted, which the first version of the trigger did not
     * distinguish. 0125 keys the dispatch `on delete cascade` so the ninety-day purge takes it with the
     * session, and a row trigger fires on that cascade exactly as on a direct delete — so refusing both
     * would stop `analytics.run_retention` on the first dead letter it reached. PostgreSQL applies the
     * parent delete before the referential action, so the session is GONE inside the trigger for a
     * cascade and PRESENT for a direct delete.
     */
    expect(sql).toContain(
      'select exists (select 1 from analytics.session s where s.session_id = old.session_id)',
    )
    expect(sql).toContain('if not v_session_survives then')
  })

  it('is reached by exhausting the BUDGET and not by the kind of refusal', () => {
    // The two answer different questions and only one is terminal: a malformed payload is refused
    // identically next time and stays `failed` inside its budget, where a later pass tries again.
    expect(dispatch).toContain('readonly budgetExhausted?: boolean')
    expect(dispatch).toContain("? 'dead_letter'")
    expect(consumer).toContain(
      'const budgetExhausted = dispatch.attempts + 1 >= ANALYTICS_MAX_ATTEMPTS',
    )
    expect(consumer).toContain(
      'const retryable = TRANSPORT_REFUSAL_IS_RETRYABLE[refusal] && !budgetExhausted',
    )
    // And the pass counts it separately from `failed`, because they are different things to go and do.
    expect(consumer).toContain('readonly deadLettered: number')
    expect(consumer).toContain('dead-lettered ${result.deadLettered}')
  })

  it('has two named readers, which is why the state exists at all', () => {
    // A dead-letter queue nothing reads is the same defect one level down from a watchdog nothing
    // watches. The console lists the rows; the watchdog puts the COUNT on every alert it raises.
    expect(sql).toContain('apps/web/app/(admin)/agents/queries.ts')
    // The CALL and not the import: an import can be aliased to something else entirely while the name
    // still appears in the file, which is how the first version of this assertion passed against a
    // console that read the open alerts instead.
    expect(consoleModule).toContain('const deadLetters = await deadLetteredDispatches(sql, {')
    expect(watchdog).toContain('deadLetteredDispatches')
    expect(watchdog).toContain('deadLetteredDispatches: deadLetters.length')
    // The index the console's read uses, partial because a dead letter is rare and the question is asked
    // on every render.
    expect(sql).toContain(
      "create index analytics_dispatch_dead_letter_idx on analytics_dispatch (decided_at desc)\n  where state = 'dead_letter'",
    )
  })
})

describe('the alert’s class', () => {
  it('is declared once as transactional, with no parameter for a caller’s preference', () => {
    expect(watchdog).toContain(
      "export const AGENT_ALERT_MESSAGE_CLASS: MessageClass = 'transactional'",
    )
    // The class is read from the constant inside the resolver, so a call site cannot name it. That is
    // what makes the `AD-` sender unreachable: the promotional identity carries the prefix, and
    // `resolveSenderIdentity` refuses a transactional slot that carries one rather than falling back.
    expect(watchdog).toContain('messageClass: AGENT_ALERT_MESSAGE_CLASS')
    expect(watchdog).toContain('resolveSenderIdentity(registry, {')
  })
})

describe('the agent A-MEAS-05 was handed no migration number for', () => {
  it('arrives with both rows, and with its OWN daily interval', () => {
    expect(sql).toContain("('offline_conversions', 'Offline conversion upload',")
    // `agentsWithHeartbeat` INNER JOINS the two, so a definition with no heartbeat row is an agent the
    // watchdog cannot see at all. 0107 shipped one without and nothing caught it until a suite read it.
    expect(sql).toContain("insert into agent_heartbeat (agent_key)\nvalues ('offline_conversions')")
    // 86400 and not 300: the whole point of the second agent is that the watchdog's 2x window is
    // measured against this pass's own cadence rather than the five-minute consumer's.
    expect(sql).toContain('86400, 0)')
  })
})
