import { loadConfig } from '@berelax/config'
import { can } from '@berelax/core'
import { createConnection, type Sql, setKillSwitch, withUnitOfWork } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { NOINDEX_ROBOTS_TAG, ROBOTS_HEADER } from '../../../../src/routes/registry.ts'
import { type AdminPrincipal, guardAdminRoute } from '../../../../src/session.ts'
import { KILL_SWITCH_DESIRED, KILL_SWITCH_FIELDS, type KillSwitchDesired } from '../render.ts'
import { AGENTS_TOGGLE_PERMISSION } from '../route.ts'

/**
 * `POST /agents/kill-switch` — stop or release one agent (G-AGT-02).
 *
 * ## Why the body carries the state to move TO and not "toggle"
 *
 * Two operators on the console at once, or one who submits twice because nothing visibly happened, are
 * the ordinary cases. A toggle flips whatever it finds, so the second submission undoes the first and
 * the agent ends up running when somebody meant to stop it — with two audit rows saying it was stopped.
 * A desired STATE is idempotent: the second submission writes the state that is already there, the audit
 * row records it, and nobody is surprised.
 *
 * ## Why the refusal is audited and the success is too
 *
 * `agent:configure` is the F07 matrix's grant and in it the receptionist does not hold it — which is the
 * acceptance line's deny-by-default case. Both outcomes write an `audit_event`: the success because
 * stopping an agent is an operational act somebody has to be accountable for, and the refusal because
 * "who tried to stop the autoresponder" is a question an insider-threat trail exists to answer
 * (docs/06 §D4). `operation: 'denied'` and `'update'` are both in `ALWAYS_AUDITED`.
 *
 * The response is a 303 back to the console, because a POST that answered with a document would make the
 * browser's back button re-submit it.
 */
export const dynamic = 'force-dynamic'

const CONSOLE_PATH = '/agents'

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function refusal(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      [ROBOTS_HEADER]: NOINDEX_ROBOTS_TAG,
    },
  })
}

const isDesired = (value: string | null): value is KillSwitchDesired =>
  value !== null && (KILL_SWITCH_DESIRED as readonly string[]).includes(value)

/** Records who tried, which agent, and which way. The entity is the AGENT: `group by entity_id` is "who touched this one". */
async function record(
  sql: Sql,
  principal: AdminPrincipal,
  entry: {
    readonly agentKey: string
    readonly desired: KillSwitchDesired
    readonly operation: 'update' | 'denied'
  },
): Promise<void> {
  await withUnitOfWork(
    sql,
    { kind: 'staff', id: principal.employeeId, label: principal.staffReference },
    async (uow) => {
      await uow.audit.record({
        action: 'agent_kill_switch.set',
        entityType: 'agent_definition',
        entityId: entry.agentKey,
        operation: entry.operation,
        // The role, the agent and the direction. Nothing a caller typed beyond the agent key, which is a
        // foreign key and is validated by the write refusing an unknown one.
        after: {
          role: principal.role,
          desired: entry.desired,
          permission: AGENTS_TOGGLE_PERMISSION,
        },
      })
    },
  )
}

export async function POST(request: Request): Promise<Response> {
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal

  try {
    // `application/x-www-form-urlencoded` only. This screen has no JSON client: it is one
    // `<form method="post">` per agent, which is what makes it work with JavaScript off. A body that is
    // not form-encoded parses to an empty `URLSearchParams` and is refused by name below.
    const body = new URLSearchParams(await request.text())
    const agentKey = body.get(KILL_SWITCH_FIELDS.agentKey)
    const desired = body.get(KILL_SWITCH_FIELDS.desired)
    if (agentKey === null || agentKey.trim() === '' || !isDesired(desired)) {
      return refusal(
        400,
        'A kill-switch POST carries the agent and the state to move it to (on or off). It is a desired ' +
          'state and never a toggle, so a replayed submission writes what the form was rendered for.',
      )
    }

    if (!can(principal.role, AGENTS_TOGGLE_PERMISSION)) {
      await withSql(
        async (sql) => await record(sql, principal, { agentKey, desired, operation: 'denied' }),
      )
      return refusal(
        403,
        `The role "${principal.role}" may not ${AGENTS_TOGGLE_PERMISSION}, which stopping an agent ` +
          'requires. The refusal has been recorded.',
      )
    }

    const applied = await withSql(async (sql) => {
      /*
        The existence check is here and not inside `setKillSwitch`, which answers `void`: its UPDATE
        matches no row for an unknown key and reports nothing, so a POST naming an agent the registry
        does not hold would write an audit row about an agent that does not exist and answer 303 as if it
        had stopped something. Asked first, so the 404 below is a fact rather than an assumption.
      */
      const [row] = await sql<{ agentKey: string }[]>`
        select agent_key as "agentKey" from agent_definition where agent_key = ${agentKey}
      `
      if (row === undefined) return false
      await setKillSwitch(sql, agentKey, desired === 'on')
      await record(sql, principal, { agentKey, desired, operation: 'update' })
      return true
    })
    if (!applied) {
      return refusal(
        404,
        `No agent is registered as "${agentKey}". Every agent this build runs is an agent_definition ` +
          'row, and a kill switch over a key the registry does not hold would stop nothing.',
      )
    }

    // 303 and not a document: a POST that answered with HTML makes the back button re-submit it.
    return new Response(null, {
      status: 303,
      headers: { location: CONSOLE_PATH, 'cache-control': 'no-store' },
    })
  } catch (error) {
    const message = isAppError(error) ? error.message : 'Unexpected'
    return refusal(503, `The kill switch could not be set: ${message}`)
  }
}
