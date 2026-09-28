import { AppError, MESSAGING_CONTROL_KEYS, type MessagingControlKey } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The marketing kill switch's ONE home, and the only module that writes it.
 *
 * ## Why the state is read from here rather than captured anywhere
 *
 * C-AUTO-07 left `marketingKillSwitch: false` as a literal in `apps/worker/src/automation/runtime.ts` and
 * said why: *"a `false` that looks like a read is the switch nobody notices is not wired"*. This is the read.
 * The gate takes the switch as an argument, the worker and the routes resolve that argument from the row this
 * module returns, and neither holds a copy — because a second statement of the switch's state is a screen
 * that says "stopped" over a sender that is still sending.
 *
 * `scripts/check-send-chokepoint.mjs`'s `marketing-kill-switch-state-has-one-home` rule is what makes that a
 * checkable claim rather than a sentence at the top of a file: an `update messaging_control` or an
 * `insert into messaging_control` anywhere but here is a violation.
 *
 * ## Why the role is an argument and not checked here
 *
 * `packages/db` may not import `packages/core` (the dependency runs the other way), and the role matrix is
 * core's. So the refusal a person sees is `assertMayToggleMessagingControl` in `@berelax/messaging`, and the
 * layer that holds when neither it nor this module is in the path — a `psql` session, a seed, an import of
 * another environment's rows — is `messaging_control_role_may_toggle()` in migration 0098, which raises
 * `ZY082`. Both are consulted on every write through here: this function hands the role to the database,
 * which refuses it.
 *
 * That is the same arrangement 0087 uses for the promotional window's ceiling, and for the same reason: the
 * figure exists in exactly two places, and the pair is asserted equal BEHAVIOURALLY rather than trusted —
 * gate case 126d drives the SQL predicate with the role matrix's own answers.
 */

/** One control row, as a screen and the gate both need it. */
export interface MessagingControlRow {
  readonly controlKey: MessagingControlKey
  readonly engaged: boolean
  /** Epoch milliseconds, for the same reason `agentsWithHeartbeat` returns them: no clock in this layer. */
  readonly changedAt: number
  readonly changedBy: string
  readonly changedByRole: string
  readonly reason: string
  readonly direction: 'engage' | 'disengage'
}

/**
 * Every control, keyed by name. Total over {@link MESSAGING_CONTROL_KEYS}, or it throws.
 *
 * Total rather than partial, and that is the whole point of the migration seeding both rows: a reader that
 * copes with a missing row has a default written into it, and a default in the reader is the second statement
 * of the switch's state this module exists to prevent. A missing row is a schema fault — somebody deleted one
 * past `ZY084`, or a restore dropped it — and the honest answer is a refusal, not `false`.
 *
 * A refusal here fails CLOSED at every caller that matters, because of the way the answer is used: the gate's
 * `marketingKillSwitch` is resolved from this read, and a throw means no promotional send is attempted at all
 * rather than one being attempted with the switch assumed off.
 */
export async function readMessagingControls(
  sql: Sql,
): Promise<Readonly<Record<MessagingControlKey, MessagingControlRow>>> {
  const rows = await sql<
    {
      controlKey: string
      engaged: boolean
      changedAt: Date
      changedBy: string
      changedByRole: string
      reason: string
      direction: string
    }[]
  >`
    select control_key     as "controlKey",
           engaged,
           changed_at      as "changedAt",
           changed_by      as "changedBy",
           changed_by_role as "changedByRole",
           reason,
           direction
    from messaging_control
    order by control_key
  `

  const found = new Map<string, MessagingControlRow>()
  for (const row of rows) {
    found.set(row.controlKey, {
      controlKey: row.controlKey as MessagingControlKey,
      engaged: row.engaged,
      changedAt: row.changedAt.getTime(),
      changedBy: row.changedBy,
      changedByRole: row.changedByRole,
      reason: row.reason,
      direction: row.direction === 'engage' ? 'engage' : 'disengage',
    })
  }

  const missing = MESSAGING_CONTROL_KEYS.filter((key) => !found.has(key))
  if (missing.length > 0) {
    throw new AppError(
      'invariant_violated',
      `messaging_control is missing ${missing.join(', ')}. Migration 0098 seeds every control, so a ` +
        'missing row is not "disengaged" — it is a row somebody removed or a restore dropped, and ' +
        'answering "disengaged" for it would silently restart promotional sending. Re-apply 0098.',
      { details: { missing: [...missing] } },
    )
  }

  return Object.fromEntries(
    MESSAGING_CONTROL_KEYS.map((key) => [key, found.get(key) as MessagingControlRow]),
  ) as Record<MessagingControlKey, MessagingControlRow>
}

export interface ToggleMessagingControlInput {
  readonly controlKey: MessagingControlKey
  /** Where the control is being moved TO. `engaged === current` is a no-op and is refused; see below. */
  readonly engaged: boolean
  /** The acting role. Handed to the database, which refuses one that may not toggle (`ZY082`). */
  readonly role: string
  /** Who, as a label. Text rather than a credential reference — see the module header on 0075. */
  readonly actorLabel: string
  readonly reason: string
  /** Epoch milliseconds. Supplied, because nothing in this codebase reads the clock directly. */
  readonly at: number
}

export interface ToggleMessagingControlResult {
  readonly before: MessagingControlRow
  readonly after: MessagingControlRow
  readonly direction: 'engage' | 'disengage'
}

/**
 * Moves one control, and writes the audit row in the same transaction.
 *
 * The audit row is not an afterthought and is not optional: it carries the actor, the DIRECTION and the
 * REASON, which is the acceptance line, and it commits with the UPDATE or neither happens. An audit row
 * written afterwards in a second transaction is a record of a change that may not have landed.
 *
 * A no-op toggle is REFUSED rather than silently accepted. Engaging an already-engaged switch would append a
 * second "stopped marketing" row with a new reason and a new actor over a state nothing changed about, and
 * the record would then read as two incidents. It is also the shape a double-submitted form takes.
 */
export async function toggleMessagingControl(
  uow: UnitOfWork,
  input: ToggleMessagingControlInput,
): Promise<ToggleMessagingControlResult> {
  if (!(MESSAGING_CONTROL_KEYS as readonly string[]).includes(input.controlKey)) {
    throw new AppError(
      'validation',
      `'${input.controlKey}' is not a messaging control. The two are ` +
        `${MESSAGING_CONTROL_KEYS.join(' and ')}, and there is deliberately none naming transactional ` +
        'traffic.',
      { details: { controlKey: input.controlKey } },
    )
  }
  if (input.reason.trim() === '') {
    throw new AppError(
      'validation',
      'A messaging control may not be toggled without a reason. The reason is what the next person reads ' +
        'before deciding whether the switch can come back off.',
      { userFacing: true, details: { controlKey: input.controlKey } },
    )
  }

  const before = (await readMessagingControls(uow.sql))[input.controlKey]
  if (before.engaged === input.engaged) {
    throw new AppError(
      'conflict',
      `'${input.controlKey}' is already ${input.engaged ? 'engaged' : 'disengaged'}. A no-op toggle would ` +
        'append a second incident over a state nothing changed about, with a new actor and a new reason.',
      { userFacing: true, details: { controlKey: input.controlKey, engaged: input.engaged } },
    )
  }

  const direction: 'engage' | 'disengage' = input.engaged ? 'engage' : 'disengage'
  await uow.sql`
    update messaging_control
       set engaged         = ${input.engaged},
           changed_at      = ${new Date(input.at)},
           changed_by      = ${input.actorLabel},
           changed_by_role = ${input.role},
           reason          = ${input.reason},
           direction       = ${direction}
     where control_key = ${input.controlKey}
  `

  const after = (await readMessagingControls(uow.sql))[input.controlKey]
  await uow.audit.record({
    action: `messaging.${input.controlKey}.${direction}d`,
    entityType: 'messaging_control',
    entityId: input.controlKey,
    operation: 'update',
    before: { engaged: before.engaged, reason: before.reason, changedByRole: before.changedByRole },
    after: {
      engaged: after.engaged,
      direction,
      reason: after.reason,
      changedByRole: after.changedByRole,
      changedBy: after.changedBy,
    },
  })

  return { before, after, direction }
}
