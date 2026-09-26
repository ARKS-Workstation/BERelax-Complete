import { AppError } from '@berelax/shared'
import type { Actor } from '../audit.ts'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import { type Enrolment, enrolOnLiveVersion } from './flow.ts'

/**
 * The pipeline board: reading it, reordering its columns, and moving a card between them.
 *
 * Three writes and one read, and the unit is the shape of them:
 *
 *   - **The board is ONE query.** `readPipelineBoard` issues a single statement for every column and every
 *     card in it. A query per column is the obvious implementation and it is the one B-UI-03 proved wrong
 *     for the calendar's two axes: six columns is six round trips that can disagree with each other,
 *     because a card moved between the second and the fifth appears twice or not at all.
 *     `pipeline-board.itest.ts` COUNTS the statements by wrapping `Sql`, which is how that claim is made
 *     about the code that runs rather than about the code somebody read.
 *   - **A move writes the card and the log together.** `moveCard` does both inside one transaction because
 *     the database refuses either alone: `customer_pipeline_card_records_every_move` is a DEFERRED
 *     constraint trigger that, at COMMIT, requires a `pipeline_stage_transition` row for exactly this move
 *     (ZU001). There is no ordering that satisfies it except writing both.
 *   - **A reorder is a PERMUTATION.** `reorderPipelineStages` takes the whole order and refuses anything
 *     that is not a permutation of the stages that exist, then writes every position in one transaction.
 *     The UNIQUE constraint and the gapless check are both deferred to COMMIT, so the shuffle needs no
 *     scratch positions — which is the trick that leaves negative positions behind when a transaction
 *     dies half way through.
 *
 * ## Stage entry enrols through the enrolment API, and this file does not have one of its own
 *
 * `pipeline_stage.entry_flow_key` names the flow a stage starts. `moveCard` calls
 * {@link PIPELINE_ENROLMENT_PATH}`.enrol`, which IS `enrolOnLiveVersion` — the writer C-AUTO-06 published
 * and the one every other trigger will use — and `pipeline-board.itest.ts` compares the reference with
 * `toBe` against what `@berelax/db` exports, because a path that behaves the same today is how two paths
 * come to disagree quietly. Nothing here resolves a live version, decides a pin, or counts an enrolment:
 * a refusal from that function travels out of `moveCard` unchanged, so whatever cap C-AUTO-07 adds to it
 * applies to a stage entry the moment it exists.
 */

// ------------------------------------------------------------------------------------------------
// Refusals
// ------------------------------------------------------------------------------------------------

/** Every reason a pipeline write is refused, as a value. Callers branch on these, never on prose. */
export const PIPELINE_REFUSALS = [
  'stage_not_found',
  /** The target column has been archived. The 409 the board's optimistic card is reverted by. */
  'stage_archived',
  'customer_not_found',
  /** The card is already in that column. A move that moves nothing is an error, not a no-op. */
  'card_already_in_stage',
  /** A reorder that is not a permutation of the stages that exist: a duplicate, a gap or a stranger. */
  'order_is_not_a_permutation',
  /** The stage names a flow, and the enrolment writer refused it. `details.flowRefusal` carries why. */
  'stage_entry_flow_refused',
  /**
   * The stage names a flow whose live definition is not triggered by `pipeline.stage_entered`.
   *
   * Fail closed rather than enrol anyway. A flow drawn to start on a completed appointment, wired to a
   * column by mistake, would otherwise enrol everybody the front desk drags there onto a graph whose
   * trigger node says something else — and the flow would run, so nothing would look wrong.
   */
  'stage_entry_flow_not_triggered_by_stage_entry',
] as const
export type PipelineRefusal = (typeof PIPELINE_REFUSALS)[number]

/** The private SQLSTATEs 0077 raises. Private, so a probe cannot be satisfied by another trigger. */
export const PIPELINE_SQLSTATE = {
  /** A card created or moved with no transition row recording the move. */
  moveUnrecorded: 'ZU001',
  /** UPDATE or DELETE on `pipeline_stage_transition`. */
  transitionImmutable: 'ZU002',
  /** `pipeline_stage.display_order` is not 1..n. */
  positionsNotGapless: 'ZU003',
} as const

/** The audit actions this module writes. Named, so a coverage test can enumerate them. */
export const PIPELINE_AUDIT_ACTIONS = {
  /** The reorder. The CARD's own changes are audited by trigger — see the note on `moveCard`. */
  stagesReordered: 'pipeline.stages_reordered',
  stageArchived: 'pipeline.stage_archived',
} as const

function refuse(
  refusal: PipelineRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AppError(
    refusal === 'stage_not_found' || refusal === 'customer_not_found' ? 'not_found' : 'conflict',
    message,
    { details: { ...details, refusal } },
  )
}

/** The named refusal carried on an error this module raised, or null. */
export function pipelineRefusalOf(err: unknown): PipelineRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' && (PIPELINE_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as PipelineRefusal)
    : null
}

// ------------------------------------------------------------------------------------------------
// The enrolment seam
// ------------------------------------------------------------------------------------------------

/**
 * The enrolment writer a stage entry uses, as a reference.
 *
 * Exported for one assertion, and it is an acceptance criterion: *"stage entry creates a flow enrolment
 * through the same enrolment API as any other trigger — no bespoke path"*. A wrapper around the right
 * function passes every behavioural test and fails this. Same device as `CALENDAR_WRITE_PATHS` in
 * `app/(admin)/calendar/handler.ts`, and for the same reason.
 */
export const PIPELINE_ENROLMENT_PATH = {
  enrol: enrolOnLiveVersion,
} as const

/**
 * The shape `enrolOnLiveVersion` presents to this module, so a test can inject one that refuses.
 *
 * A structural MIRROR rather than a reduced shape of its own: the real function is assignable to this with
 * no adapter, and an adapter is where a cap would come to be skipped. The default IS the real one.
 */
export type StageEntryEnroller = (
  uow: UnitOfWork,
  input: {
    readonly flowKey: string
    readonly customerId: string
    readonly createdBy: string
    readonly at: Date
  },
) => Promise<Enrolment>

export interface PipelineDeps {
  /** Defaults to `PIPELINE_ENROLMENT_PATH.enrol`. Injected only so a refusal can be provoked. */
  readonly enrol?: StageEntryEnroller
}

// ------------------------------------------------------------------------------------------------
// The read
// ------------------------------------------------------------------------------------------------

export interface PipelineCard {
  readonly customerId: string
  /** Whatever the front desk typed, or null. Never a name this system invented (ADR 0020). */
  readonly displayName: string | null
  readonly phoneE164: string
  readonly lifecycleState: string
  readonly isVip: boolean
  readonly stageEnteredAtIso: string
}

export interface PipelineColumn {
  readonly stageKey: string
  readonly displayOrder: number
  readonly description: string
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  /** The flow entry to this column starts, or null. */
  readonly entryFlowKey: string | null
  readonly cards: readonly PipelineCard[]
}

export interface PipelineBoard {
  readonly columns: readonly PipelineColumn[]
  /** How many cards the board holds, summed from the columns rather than counted again. */
  readonly cardCount: number
}

/**
 * The whole board in ONE statement: every live column, and every card in it.
 *
 * One statement rather than one per column, which is the acceptance criterion B-UI-03 established for the
 * calendar's two axes. Six queries can disagree with each other — a card moved between the second and the
 * fifth appears twice or not at all — and the result is a board that is wrong in a way no single row is.
 *
 * ## Two filters that are not obvious and are both load-bearing
 *
 * **Archived columns are left out**, and their cards with them. A card in an archived column is not lost:
 * the row is still there, the log still names it, and un-archiving brings it back. What must not happen is
 * the board offering a column nobody may move a card into, because the move would then be refused by
 * `stage_archived` for a column the page had just drawn.
 *
 * **A merged-away contact is left out.** `customer_pipeline_card`'s merge strategy is `repoint_update` with
 * the customer id as the whole key, so when the survivor already has a card the loser's is RETAINED rather
 * than moved (`packages/db/src/merge-participants.ts` states why). The loser's `customer` row also survives
 * as a tombstone, so without this filter the board would draw both records — one person, two cards, and a
 * drag on the wrong one moves a card nothing else reads.
 */
export async function readPipelineBoard(sql: Sql): Promise<PipelineBoard> {
  const rows = await sql<
    {
      stage_key: string
      display_order: number
      description: string
      is_provisional: boolean
      open_question_id: string | null
      entry_flow_key: string | null
      customer_id: string | null
      display_name: string | null
      phone_e164: string | null
      lifecycle_state: string | null
      is_vip: boolean | null
      stage_entered_at: Date | null
    }[]
  >`
    select s.stage_key,
           s.display_order,
           s.description,
           s.is_provisional,
           s.open_question_id,
           s.entry_flow_key,
           c.customer_id,
           cu.display_name,
           cu.phone_e164,
           cu.lifecycle_state,
           cu.is_vip,
           c.stage_entered_at
      from pipeline_stage s
      left join customer_pipeline_card c
        on c.stage_key = s.stage_key
       and not exists (
             select 1 from merge_record m where m.loser_customer_id = c.customer_id
           )
      left join customer cu on cu.id = c.customer_id
     where s.archived_at is null
     order by s.display_order, c.stage_entered_at, c.customer_id
  `

  const columns: PipelineColumn[] = []
  let cardCount = 0
  for (const row of rows) {
    let column = columns.at(-1)
    if (column === undefined || column.stageKey !== row.stage_key) {
      column = {
        stageKey: row.stage_key,
        displayOrder: row.display_order,
        description: row.description,
        isProvisional: row.is_provisional,
        openQuestionId: row.open_question_id,
        entryFlowKey: row.entry_flow_key,
        cards: [],
      }
      columns.push(column)
    }
    // A LEFT JOIN answers one row with every card column null for an empty stage. `customer_id` null is
    // the discriminator and `stage_entered_at` is checked with it rather than trusted: a card whose
    // contact row has gone would otherwise be pushed with an empty phone and render as a blank card.
    if (row.customer_id === null || row.stage_entered_at === null || row.phone_e164 === null)
      continue
    ;(column.cards as PipelineCard[]).push({
      customerId: row.customer_id,
      displayName: row.display_name,
      phoneE164: row.phone_e164,
      lifecycleState: row.lifecycle_state ?? 'unknown',
      isVip: row.is_vip ?? false,
      stageEnteredAtIso: row.stage_entered_at.toISOString(),
    })
    cardCount += 1
  }
  return { columns, cardCount }
}

export interface PipelineStageRow {
  readonly stageKey: string
  readonly displayOrder: number
  readonly archivedAtIso: string | null
  readonly entryFlowKey: string | null
}

/** Every stage including the archived ones, in position order. What a reorder is computed against. */
export async function readPipelineStages(sql: Sql): Promise<readonly PipelineStageRow[]> {
  const rows = await sql<
    {
      stage_key: string
      display_order: number
      archived_at: Date | null
      entry_flow_key: string | null
    }[]
  >`
    select stage_key, display_order, archived_at, entry_flow_key
      from pipeline_stage order by display_order
  `
  return rows.map((row) => ({
    stageKey: row.stage_key,
    displayOrder: row.display_order,
    archivedAtIso: row.archived_at?.toISOString() ?? null,
    entryFlowKey: row.entry_flow_key,
  }))
}

// ------------------------------------------------------------------------------------------------
// Moving a card
// ------------------------------------------------------------------------------------------------

export interface MoveCardInput {
  readonly customerId: string
  readonly toStageKey: string
  readonly actor: Actor
  /**
   * When the move happened, from an injected clock.
   *
   * Explicit rather than left to a `now()` default, for 0070's reason about `enrolled_at`: the card's
   * `stage_entered_at` and the transition's `occurred_at` must be the SAME instant — that equality is what
   * `customer_pipeline_card_records_every_move` checks — and two `now()` calls in one transaction agree
   * only because `now()` is the transaction timestamp, which is a coincidence a reader should not have to
   * know about. Passing it also makes the ordering testable under a frozen clock.
   */
  readonly at: Date
}

export interface MoveCardOutcome {
  readonly customerId: string
  readonly fromStageKey: string | null
  readonly toStageKey: string
  readonly transitionId: string
  readonly occurredAtIso: string
  /** The enrolment the entry started, or null when the column names no flow. */
  readonly enrolment: Enrolment | null
}

/**
 * Enrols one contact on the flow a column starts, through the writer every other trigger uses.
 *
 * Separated from {@link moveCard} so that the function holding the write is readable, and because the two
 * refusals here are the whole of what "the same enrolment API as any other trigger" costs: the document
 * has to SAY it starts on a stage entry, and a refusal from the writer travels out rather than being
 * absorbed.
 */
async function enrolOnStageEntry(
  uow: UnitOfWork,
  enrol: StageEntryEnroller,
  args: {
    readonly flowKey: string
    readonly stageKey: string
    readonly customerId: string
    readonly actor: Actor
    readonly at: Date
  },
): Promise<Enrolment> {
  // The document has to SAY it starts on a stage entry. `flow_definition` holds the published versions and
  // the live one is `max(version)` by construction (0070), so the check is asked of the version an
  // enrolment would pin. `jsonb_path_exists` rather than unpacking the nodes in TypeScript: the question
  // is one predicate over one document, and reading the graph here would be the beginning of a second
  // interpreter (C-AUTO-07 owns the only one).
  const [declares] = await uow.sql<{ ok: boolean }[]>`
    select exists (
      select 1
        from flow f
        join flow_definition d on d.flow_id = f.id
       where f.flow_key = ${args.flowKey}
         and d.version = (select max(version) from flow_definition where flow_id = f.id)
         and jsonb_path_exists(
               d.definition,
               '$.nodes[*] ? (@.kind == "trigger" && @.event == "pipeline.stage_entered")'
             )
    ) as ok
  `
  if (declares?.ok !== true) {
    refuse(
      'stage_entry_flow_not_triggered_by_stage_entry',
      `The "${args.stageKey}" column starts flow "${args.flowKey}", whose live version does not declare ` +
        'a pipeline.stage_entered trigger. Enrolling anyway would run a graph whose own trigger node ' +
        'says it starts on something else, and nothing afterwards would look wrong.',
      { stageKey: args.stageKey, flowKey: args.flowKey },
    )
  }
  try {
    return await enrol(uow, {
      flowKey: args.flowKey,
      customerId: args.customerId,
      createdBy: args.actor.label ?? `Pipeline stage entry (${args.actor.kind})`,
      at: args.at,
    })
  } catch (error) {
    // Re-thrown as this module's refusal with the enrolment writer's OWN refusal carried in the details,
    // never swallowed. A stage entry that silently failed to enrol is a flow an operator configured and
    // will wait for; and this is what makes a cap added to `enrolOnLiveVersion` apply here — the refusal
    // travels out rather than being absorbed by a path of our own.
    refuse(
      'stage_entry_flow_refused',
      `Entry to "${args.stageKey}" could not enrol the contact on flow "${args.flowKey}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
      {
        stageKey: args.stageKey,
        flowKey: args.flowKey,
        flowRefusal:
          error instanceof AppError
            ? ((error.details as { refusal?: unknown } | undefined)?.refusal ?? null)
            : null,
      },
    )
  }
}

/**
 * Moves one card into one column, records the move, and enrols the contact if the column starts a flow.
 *
 * ## Why there is no audit call in this function
 *
 * `customer_pipeline_card` is registered in `CRM_AUDIT_COVERAGE` as audited BY TRIGGER, and
 * `customer_pipeline_card_audit` writes the `audit_event` row. That is deliberate and it is not the easy
 * choice: the register's two arms are about who can be trusted to record a change, and for this table the
 * honest answer is nobody — the row is one column and one instant, a psql UPDATE is a plausible
 * correction, and a stage must be attributable however it changed. So the actor goes into the
 * transaction-local `berelax.audit_actor_*` settings (0036's mechanism, the same three `set_config` calls
 * `reclassifyTemplate` makes) and the trigger reads them. A second `uow.audit.record` here would be two
 * audit rows for one move, and a reader would have to know which one to believe.
 *
 * ## Why the card is written before the log
 *
 * Because the log describes the card's new position and the deferred trigger does not care about order.
 * The reverse order works equally well, which is the point: there is NO order that satisfies the trigger
 * with only one of the two rows written, so the pair cannot come apart.
 */
export async function moveCard(
  uow: UnitOfWork,
  input: MoveCardInput,
  deps: PipelineDeps = {},
): Promise<MoveCardOutcome> {
  const { sql } = uow
  const enrol = deps.enrol ?? PIPELINE_ENROLMENT_PATH.enrol

  const [stage] = await sql<
    { stage_key: string; archived_at: Date | null; entry_flow_key: string | null }[]
  >`
    select stage_key, archived_at, entry_flow_key from pipeline_stage
     where stage_key = ${input.toStageKey}
  `
  if (stage === undefined) {
    refuse('stage_not_found', `No pipeline stage is called "${input.toStageKey}".`, {
      stageKey: input.toStageKey,
    })
  }
  if (stage.archived_at !== null) {
    refuse(
      'stage_archived',
      `The "${input.toStageKey}" column has been archived, so no card may be moved into it. The board ` +
        'the move was dragged on is out of date; reload it.',
      { stageKey: input.toStageKey },
    )
  }

  // FOR UPDATE on the contact, so two drags of one card serialise. Without it both would read the same
  // `from` stage and write two transitions claiming to start from the same column, and the board's
  // history would then contain a move that never happened.
  const [contact] = await sql<{ id: string }[]>`
    select id from customer where id = ${input.customerId}::uuid for update
  `
  if (contact === undefined) {
    refuse('customer_not_found', `No customer with id ${input.customerId}.`, {
      customerId: input.customerId,
    })
  }

  const [existing] = await sql<{ stage_key: string }[]>`
    select stage_key from customer_pipeline_card where customer_id = ${input.customerId}::uuid
  `
  const fromStageKey = existing?.stage_key ?? null
  if (fromStageKey === input.toStageKey) {
    refuse(
      'card_already_in_stage',
      `That card is already in "${input.toStageKey}". A move that moves nothing would write a ` +
        'transition saying a stage was entered when nobody entered it.',
      { customerId: input.customerId, stageKey: input.toStageKey },
    )
  }

  // The actor for the audit trigger. Three settings and not one, because a filter wants the kind and a
  // reader wants the label; `set_config` cannot store NULL, so an absent id is '' and the trigger
  // normalises it (0053).
  await sql`select set_config('berelax.audit_actor_kind', ${input.actor.kind}, true)`
  await sql`select set_config('berelax.audit_actor_label', ${input.actor.label ?? ''}, true)`
  await sql`select set_config('berelax.audit_actor_id', ${input.actor.id ?? ''}, true)`

  if (fromStageKey === null) {
    await sql`
      insert into customer_pipeline_card (customer_id, stage_key, stage_entered_at)
      values (${input.customerId}::uuid, ${input.toStageKey}, ${input.at})
    `
  } else {
    await sql`
      update customer_pipeline_card
         set stage_key = ${input.toStageKey}, stage_entered_at = ${input.at}
       where customer_id = ${input.customerId}::uuid
    `
  }

  const [transition] = await sql<{ id: string }[]>`
    insert into pipeline_stage_transition
      (customer_id, from_stage_key, to_stage_key, actor_kind, actor_label, occurred_at)
    values (${input.customerId}::uuid, ${fromStageKey}, ${input.toStageKey}, ${input.actor.kind},
            ${input.actor.label ?? `${input.actor.kind} with no stated label`}, ${input.at})
    returning id
  `
  const transitionId = (transition as { id: string }).id

  const enrolment =
    stage.entry_flow_key === null
      ? null
      : await enrolOnStageEntry(uow, enrol, {
          flowKey: stage.entry_flow_key,
          stageKey: input.toStageKey,
          customerId: input.customerId,
          actor: input.actor,
          at: input.at,
        })

  return {
    customerId: input.customerId,
    fromStageKey,
    toStageKey: input.toStageKey,
    transitionId,
    occurredAtIso: input.at.toISOString(),
    enrolment,
  }
}

export interface TransitionRow {
  readonly id: string
  readonly customerId: string
  readonly fromStageKey: string | null
  readonly toStageKey: string
  readonly actorKind: string
  readonly actorLabel: string
  readonly occurredAtIso: string
}

/** One contact's move history, newest first. Read through the index the log carries for it. */
export async function readCardHistory(
  sql: Sql,
  customerId: string,
): Promise<readonly TransitionRow[]> {
  const rows = await sql<
    {
      id: string
      customer_id: string
      from_stage_key: string | null
      to_stage_key: string
      actor_kind: string
      actor_label: string
      occurred_at: Date
    }[]
  >`
    select id, customer_id, from_stage_key, to_stage_key, actor_kind, actor_label, occurred_at
      from pipeline_stage_transition
     where customer_id = ${customerId}::uuid
     order by occurred_at desc, id desc
  `
  return rows.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    fromStageKey: row.from_stage_key,
    toStageKey: row.to_stage_key,
    actorKind: row.actor_kind,
    actorLabel: row.actor_label,
    occurredAtIso: row.occurred_at.toISOString(),
  }))
}

// ------------------------------------------------------------------------------------------------
// Reordering
// ------------------------------------------------------------------------------------------------

export interface ReorderInput {
  /** Every stage key that exists, in the order the board should show them. A permutation, not a patch. */
  readonly order: readonly string[]
}

/**
 * Writes the whole column order, refusing anything that is not a permutation of the stages that exist.
 *
 * A permutation and not a patch, which is the decision that makes the gapless rule keepable. "Move
 * `booked` to position 1" is a patch, and a patch has to compute what happens to the four rows it did not
 * mention — arithmetic that is wrong in a different way for a move up than for a move down, and whose
 * failure is a gap nobody sees until a column renders empty. The whole order is checked once, against the
 * table, before anything is written.
 *
 * The duplicate and the stranger are refused HERE rather than left to the database, because the database's
 * answer arrives at COMMIT and names a constraint. `order_is_not_a_permutation` names the problem and
 * `details` carries which keys were duplicated, missing or unknown, which is what a settings screen has to
 * show somebody. The deferred constraints remain the backstop: they are what makes this the only way in.
 */
export async function reorderPipelineStages(
  uow: UnitOfWork,
  input: ReorderInput,
): Promise<readonly PipelineStageRow[]> {
  const { sql } = uow
  // FOR UPDATE over the whole vocabulary, so two reorders serialise: without it both would validate
  // against the same six keys and the loser's positions would be written over half the winner's.
  const existing = await sql<{ stage_key: string }[]>`
    select stage_key from pipeline_stage order by stage_key for update
  `
  const present = existing.map((row) => row.stage_key)
  const asked = [...input.order]

  const duplicated = asked.filter((key, index) => asked.indexOf(key) !== index)
  const unknown = asked.filter((key) => !present.includes(key))
  const missing = present.filter((key) => !asked.includes(key))
  if (duplicated.length > 0 || unknown.length > 0 || missing.length > 0) {
    refuse(
      'order_is_not_a_permutation',
      'A stage order is the whole board, in order: every stage exactly once. ' +
        `${duplicated.length} duplicated, ${unknown.length} unknown, ${missing.length} left out.`,
      { duplicated, unknown, missing, expected: present.length },
    )
  }

  // One UPDATE per stage, no scratch positions, and no ORDER the statements have to be issued in: the
  // UNIQUE constraint and the gapless trigger are both deferred to COMMIT, so the intermediate states
  // that hold a duplicate are never checked. A scratch pass (`set display_order = -n`) is the shape this
  // replaces, and it leaves negative positions behind when a transaction dies half way through.
  for (const [index, stageKey] of asked.entries()) {
    await sql`
      update pipeline_stage set display_order = ${index + 1} where stage_key = ${stageKey}
    `
  }

  await uow.audit.record({
    action: PIPELINE_AUDIT_ACTIONS.stagesReordered,
    entityType: 'pipeline_stage',
    operation: 'update',
    before: { order: present },
    after: { order: asked },
  })

  return await readPipelineStages(sql)
}

export interface ArchiveStageInput {
  readonly stageKey: string
  readonly at: Date
}

/**
 * Takes one column off the board, keeping its row and its position.
 *
 * The position stays, which is the decision the gapless rule forces and the right one anyway: a
 * transition row names this stage and cannot be rewritten, so renumbering the survivors to close the gap
 * would reorder the board as a side effect of hiding one column. `readPipelineBoard` filters archived
 * columns out, so the gap is invisible on the board and visible in `readPipelineStages`, which is where
 * somebody un-archiving one needs to see it.
 */
export async function archivePipelineStage(
  uow: UnitOfWork,
  input: ArchiveStageInput,
): Promise<void> {
  const { sql } = uow
  const [row] = await sql<{ archived_at: Date | null }[]>`
    update pipeline_stage set archived_at = ${input.at}
     where stage_key = ${input.stageKey} and archived_at is null
    returning archived_at
  `
  if (row === undefined) {
    // Absent or already archived, and the two are told apart rather than folded together: archiving an
    // archived column twice is a no-op somebody should know was a no-op.
    const [exists] = await sql<{ stage_key: string }[]>`
      select stage_key from pipeline_stage where stage_key = ${input.stageKey}
    `
    if (exists === undefined) {
      refuse('stage_not_found', `No pipeline stage is called "${input.stageKey}".`, {
        stageKey: input.stageKey,
      })
    }
    refuse('stage_archived', `The "${input.stageKey}" column is already archived.`, {
      stageKey: input.stageKey,
    })
  }
  await uow.audit.record({
    action: PIPELINE_AUDIT_ACTIONS.stageArchived,
    entityType: 'pipeline_stage',
    entityId: input.stageKey,
    operation: 'update',
    after: { archivedAt: input.at.toISOString() },
  })
}
