import {
  type Actor,
  createConnection,
  readMessagingControls,
  type Sql,
  toggleMessagingControl,
  withUnitOfWork,
} from '@berelax/db'
import { assertMayToggleMessagingControl, resolveMarketingKillSwitch } from '@berelax/messaging'
import { MESSAGING_CONTROL_KEYS } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * C-AUTO-05 — the kill switch's one home, who may move it, and what the DATABASE refuses.
 *
 * The behaviour of an engaged switch is asserted where the send path is: `packages/messaging/src/gate/
 * kill-switch.test.ts` drives the whole shipped corpus through `sendMessage`, and
 * `apps/worker/src/jobs/send-scheduled-step.itest.ts` proves a reminder still leaves with the switch on.
 * What can only be asserted against a real PostgreSQL is here, and it is four things:
 *
 *   1. **The state has ONE home and the gate's argument is resolved from it.** `readMessagingControls` plus
 *      `resolveMarketingKillSwitch` is the whole of the read, and the row is what the answer changes with.
 *   2. **Every toggle writes an `audit_event` carrying the actor, the direction and the reason**, in the same
 *      transaction as the row. Asserted as a DELTA, because `audit_event` is append-only (ADR 0008).
 *   3. **The role rule holds in the database**, not only in TypeScript. `ZY082` is what refuses a `psql`
 *      session, a seed, or an import of another environment's rows — the three routes in that no TypeScript
 *      assertion is standing in.
 *   4. **The row cannot be DELETEd** (`ZY084`). A delete is a disengagement that writes no audit row: the
 *      reader finds nothing, nothing is engaged, and there is no actor or reason anywhere.
 *
 * ## What this suite may and may not remove
 *
 * Nothing. Migration 0098 seeds both control rows, `audit_event` is append-only, and `messaging_control`
 * refuses DELETE for every role — so the only cleanup available is moving the switch back, which is an
 * UPDATE and which is done in a `finally` per case. Every count here is therefore a delta narrowed to this
 * run's marker, and no assertion is about a total.
 *
 * The row is SHARED with every other suite in the database: `apps/worker`'s interpreter reads it on every
 * promotional flow send. A case that left it engaged would refuse promotional sends in a file nobody touched,
 * which is why the restore is in a `finally` rather than in `afterEach`.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

let sql: Sql

const MARKER = 'cauto05 marketing kill switch itest'
const ACTOR: Actor = { kind: 'staff', label: MARKER }
/** A fixed instant, so `changed_at` is a value this suite chose rather than whatever the clock said. */
const ENGAGED_AT = Date.parse('2099-07-04T08:30:00.000Z')

/** Audit rows this run wrote, by action. A DELTA: `audit_event` only grows. */
async function auditRows(action: string): Promise<
  readonly {
    readonly actorLabel: string | null
    readonly operation: string
    readonly after: Record<string, unknown>
    readonly before: Record<string, unknown>
  }[]
> {
  const rows = await sql<
    {
      actor_label: string | null
      operation: string
      after_state: Record<string, unknown>
      before_state: Record<string, unknown>
    }[]
  >`
    select actor_label, operation, after_state, before_state
      from audit_event
     where action = ${action} and actor_label = ${MARKER}
     order by occurred_at, id
  `
  return rows.map((row) => ({
    actorLabel: row.actor_label,
    operation: row.operation,
    after: row.after_state,
    before: row.before_state,
  }))
}

/** Moves the switch back to disengaged, whatever happened. Never a DELETE: 0098 refuses one (ZY084). */
async function restoreDisengaged(): Promise<void> {
  const controls = await readMessagingControls(sql)
  if (!controls.marketing_kill_switch.engaged) return
  await withUnitOfWork(sql, ACTOR, (uow) =>
    toggleMessagingControl(uow, {
      controlKey: 'marketing_kill_switch',
      engaged: false,
      role: 'owner',
      actorLabel: MARKER,
      reason: 'Test teardown: restoring the seeded disengaged state.',
      at: ENGAGED_AT + 3_600_000,
    }),
  )
}

beforeAll(() => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  await restoreDisengaged()
  await sql?.end({ timeout: 5 })
})

describe('the switch has one home, and the gate reads its argument from there', () => {
  it('seeds both controls disengaged, and neither names transactional traffic', async () => {
    const controls = await readMessagingControls(sql)
    // Total over the vocabulary. A reader that coped with a missing row would have a default written into
    // it, and a default in the reader is the second statement of the switch's state.
    expect(Object.keys(controls).sort()).toEqual([...MESSAGING_CONTROL_KEYS].sort())
    for (const key of MESSAGING_CONTROL_KEYS) {
      expect(controls[key].controlKey, key).toBe(key)
      expect(controls[key].reason.trim().length, key).toBeGreaterThan(0)
      expect(controls[key].changedByRole, key).toBe('owner')
    }
    // And the point of the closed set: no control names the traffic that must never be stoppable.
    for (const key of MESSAGING_CONTROL_KEYS) {
      expect(key, key).not.toMatch(/transaction|booking|otp|confirm|reminder/i)
    }
  })

  it('changes the gate argument when the row moves, and only then', async () => {
    const readSwitch = async () =>
      resolveMarketingKillSwitch({
        stored: (await readMessagingControls(sql)).marketing_kill_switch.engaged,
        // Production, because the non-production default would engage the switch whatever the row said and
        // the claim here is about the ROW. That default is asserted in `kill-switch.test.ts`.
        appEnv: 'production',
      })

    expect(await readSwitch()).toEqual({ engaged: false, source: 'disengaged' })
    try {
      await withUnitOfWork(sql, ACTOR, (uow) =>
        toggleMessagingControl(uow, {
          controlKey: 'marketing_kill_switch',
          engaged: true,
          role: 'manager',
          actorLabel: MARKER,
          reason: 'A complaint about the weekend blast.',
          at: ENGAGED_AT,
        }),
      )
      expect(await readSwitch()).toEqual({ engaged: true, source: 'operator' })
      // `operator` rather than a bare boolean, because a screen has to be able to say who — and because an
      // engagement nobody can attribute is one nobody will take back off.
      const row = (await readMessagingControls(sql)).marketing_kill_switch
      expect(row.changedBy).toBe(MARKER)
      expect(row.changedByRole).toBe('manager')
      expect(row.direction).toBe('engage')
      expect(row.changedAt).toBe(ENGAGED_AT)
    } finally {
      await restoreDisengaged()
    }
    expect(await readSwitch()).toEqual({ engaged: false, source: 'disengaged' })
  })

  it('refuses a second engage of an already engaged switch rather than appending an incident', async () => {
    try {
      await withUnitOfWork(sql, ACTOR, (uow) =>
        toggleMessagingControl(uow, {
          controlKey: 'marketing_kill_switch',
          engaged: true,
          role: 'owner',
          actorLabel: MARKER,
          reason: 'Stopping marketing.',
          at: ENGAGED_AT,
        }),
      )
      await expect(
        withUnitOfWork(sql, ACTOR, (uow) =>
          toggleMessagingControl(uow, {
            controlKey: 'marketing_kill_switch',
            engaged: true,
            role: 'owner',
            actorLabel: MARKER,
            // The realistic shape: a double-submitted form, with a different reason attached.
            reason: 'Stopping marketing again.',
            at: ENGAGED_AT + 1000,
          }),
        ),
      ).rejects.toThrow(/already engaged/)
      // The first reason survives, which is the one that explains the state.
      expect((await readMessagingControls(sql)).marketing_kill_switch.reason).toBe(
        'Stopping marketing.',
      )
    } finally {
      await restoreDisengaged()
    }
  })
})

describe('every toggle writes an audit_event carrying the actor, the direction and the reason', () => {
  it('writes one row per direction, in the toggle transaction', async () => {
    const engageAction = 'messaging.marketing_kill_switch.engaged'
    const disengageAction = 'messaging.marketing_kill_switch.disengaged'
    const engagedBefore = (await auditRows(engageAction)).length
    const disengagedBefore = (await auditRows(disengageAction)).length

    try {
      await withUnitOfWork(sql, ACTOR, (uow) =>
        toggleMessagingControl(uow, {
          controlKey: 'marketing_kill_switch',
          engaged: true,
          role: 'manager',
          actorLabel: MARKER,
          reason: 'TDRA complaint received; stopping every campaign.',
          at: ENGAGED_AT,
        }),
      )
    } finally {
      await restoreDisengaged()
    }

    const engaged = await auditRows(engageAction)
    const disengaged = await auditRows(disengageAction)
    // A DELTA in each direction, never a total: the table is append-only and earlier runs of this suite
    // leave their rows behind (ADR 0008).
    expect(engaged.length - engagedBefore).toBe(1)
    expect(disengaged.length - disengagedBefore).toBe(1)

    const row = engaged.at(-1)
    expect(row?.operation).toBe('update')
    expect(row?.actorLabel).toBe(MARKER)
    // The three the acceptance line names, on the row rather than in the message: an audit trail somebody
    // has to parse prose out of is one nobody queries.
    expect(row?.after['direction']).toBe('engage')
    expect(row?.after['reason']).toBe('TDRA complaint received; stopping every campaign.')
    expect(row?.after['changedByRole']).toBe('manager')
    expect(row?.after['engaged']).toBe(true)
    // And what it was before, so the row answers "what changed" and not only "what it is now".
    expect(row?.before['engaged']).toBe(false)
  })

  it('writes no audit row and no change when the toggle is refused', async () => {
    const action = 'messaging.marketing_kill_switch.engaged'
    const before = (await auditRows(action)).length

    // A reason of spaces, refused by `toggleMessagingControl` before it writes anything. The row and the
    // audit row share a transaction, so a refusal has to leave neither.
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        toggleMessagingControl(uow, {
          controlKey: 'marketing_kill_switch',
          engaged: true,
          role: 'owner',
          actorLabel: MARKER,
          reason: '   ',
          at: ENGAGED_AT,
        }),
      ),
    ).rejects.toThrow(/without a reason/)

    expect((await auditRows(action)).length).toBe(before)
    expect((await readMessagingControls(sql)).marketing_kill_switch.engaged).toBe(false)
  })
})

describe('the database refuses what TypeScript refuses, for the routes TypeScript is not on', () => {
  /**
   * One raw statement inside begin/rollback.
   *
   * Raw rather than through the writer, because the whole point is the route that does NOT go through the
   * writer: a `psql` session at 02:00, a seed, an import of another environment's rows. An `update` is used
   * rather than an `insert` because `berelax_app` has no INSERT on this table (0098 revokes it) and because
   * an UPDATE matching no row exits zero — which would report "nothing was refused" about a database that
   * simply had not been seeded. Both control rows exist from the migration, so the UPDATE always matches.
   */
  const probe = (set: string): Promise<unknown> =>
    sql.begin(async (tx) => {
      await tx.unsafe(
        `update messaging_control set ${set} where control_key = 'marketing_kill_switch'`,
      )
      throw new Error('rolled back')
    })

  it('refuses a role that may not toggle, with ZY082', async () => {
    for (const role of [
      'receptionist',
      'marketer',
      'therapist',
      'accountant',
      'auditor',
      'system',
    ]) {
      await expect(
        probe(
          `engaged = true, direction = 'engage', changed_by_role = '${role}', ` +
            `changed_by = 'psql', reason = 'getting the campaign out', changed_at = now()`,
        ),
        role,
      ).rejects.toThrow(/ZY082/)
    }
  })

  it('refuses a blank reason with ZY083, and a key outside the closed set with ZY081', async () => {
    await expect(
      probe(
        `engaged = true, direction = 'engage', changed_by_role = 'owner', changed_by = 'psql', ` +
          `reason = '  ', changed_at = now()`,
      ),
    ).rejects.toThrow(/ZY083/)
    // The realistic version of the key failure: somebody adds a control for the traffic that must never be
    // stoppable. A missing row reads as "not engaged", so a key outside the set is worse than no row.
    await expect(probe(`control_key = 'transactional_kill_switch'`)).rejects.toThrow(/ZY081/)
  })

  it('refuses a DELETE with ZY084, because a delete is an unaudited disengagement', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`delete from messaging_control where control_key = 'marketing_kill_switch'`
        throw new Error('rolled back')
      }),
    ).rejects.toThrow(/ZY084/)
    // The control: the row is still there, and still disengaged. A refusal that had rolled back a real
    // deletion would look identical to one that had not been attempted.
    expect((await readMessagingControls(sql)).marketing_kill_switch.engaged).toBe(false)
  })

  it('accepts the legitimate change, so the four refusals above are not a table that refuses everything', async () => {
    // The control every refusal list needs. A predicate that refused a manager engaging the switch would
    // satisfy all four cases above while making the product unusable.
    await expect(
      probe(
        `engaged = true, direction = 'engage', changed_by_role = 'manager', ` +
          `changed_by = 'the floor manager', reason = 'complaints about the blast', changed_at = now()`,
      ),
    ).rejects.toThrow(/rolled back/)
  })

  it('agrees with the role matrix in @berelax/core, rather than being trusted to', async () => {
    // The two places "who may toggle" is written down: `settings:write` in the permission matrix, and the
    // SQL literals in `messaging_control_role_may_toggle()`. SQL cannot read the matrix, so the pair is held
    // equal BEHAVIOURALLY — the same seven roles asked of both, and the answers compared.
    const roles = [
      'owner',
      'manager',
      'accountant',
      'receptionist',
      'therapist',
      'marketer',
      'auditor',
      'system',
    ]
    const permitted: string[] = []
    for (const role of roles) {
      const [row] = await sql<{ may: boolean }[]>`
        select messaging_control_role_may_toggle(${role}) as may
      `
      const bySql = row?.may === true
      let byMatrix = true
      try {
        assertMayToggleMessagingControl({
          controlKey: 'marketing_kill_switch',
          direction: 'engage',
          role,
          reason: 'probe',
        })
      } catch {
        byMatrix = false
      }
      expect(bySql, `${role}: SQL said ${bySql}, the role matrix said ${byMatrix}`).toBe(byMatrix)
      if (bySql) permitted.push(role)
    }
    // And the answer itself, so the agreement is not two copies of "nobody may".
    expect(permitted.sort()).toEqual(['manager', 'owner'])
  })
})
