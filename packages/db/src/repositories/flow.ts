import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * Publishing a flow version, and enrolling a contact on the version that is live when they arrive.
 *
 * Two writes and three reads, and the whole unit is in the shape of them:
 *
 *   - **A publish APPENDS.** `flow_definition` refuses UPDATE and DELETE (ZF001), so the only way to
 *     change a flow is to write version N+1. The version number is `max(version) + 1` computed under a
 *     lock on the `flow` row, with the composite primary key as the backstop: two publishes racing would
 *     otherwise both read N and both write N+1, and the loser's document would be the one nobody has.
 *   - **An enrolment PINS.** It stores `(flow_id, definition_version)` with a composite foreign key to the
 *     exact version row, resolved once at enrolment time. Nothing reads `max(version)` afterwards, and the
 *     pin cannot be moved (ZF002).
 *
 * ## Why the validator is injected
 *
 * The DSL's rules live in `@berelax/core` (`automation/dsl.ts`, `automation/static-analysis.ts`) and this
 * package may not import it — the dependency runs core <- db and never back (brief rule 4). So
 * {@link publishFlowDefinition} takes a `validate` function whose type is a structural mirror of
 * `validateFlowDefinition`, which means the real one is injectable with no adapter to get wrong. With NO
 * validator it refuses by name rather than publishing: an unvalidated definition in this table is a flow
 * that fails when it runs, days later, for the enrolments that were pinned to it.
 */

// ------------------------------------------------------------------------------------------------
// Refusals and the private SQLSTATEs
// ------------------------------------------------------------------------------------------------

/** Every reason a flow write is refused, as a value. Callers branch on these, never on prose. */
export const FLOW_REFUSALS = [
  'flow_not_found',
  /** No validator was injected, so nothing checked the document. Fail closed. */
  'definition_not_validated',
  /** The validator refused. `details.rules` carries its named rules. */
  'definition_invalid',
  /**
   * The document's own `key` is not the flow it is being published to.
   *
   * `flow_definition` holds no key column — the flow row is the key — so the database cannot catch this,
   * and the symptom is a flow whose published document says it is a different flow.
   */
  'definition_key_does_not_match_flow',
  /** Enrolment into a flow that is not accepting new enrolments. */
  'flow_not_active',
  /** Enrolment into a flow with no published version: there is nothing to pin. */
  'flow_has_no_published_version',
  'enrolment_not_found',
  /** Ending an enrolment that has already ended. A second ending is an error, not a no-op. */
  'enrolment_not_active',
] as const
export type FlowWriteRefusal = (typeof FLOW_REFUSALS)[number]

/**
 * The private SQLSTATEs 0070 raises.
 *
 * Private rather than `restrict_violation`, for 0061's reason: that code is also raised by seven other
 * triggers and every ON DELETE RESTRICT foreign key in this schema, so a probe asserting it passes when
 * the statement bounced off something else entirely.
 */
export const FLOW_SQLSTATE = {
  definitionImmutable: 'ZF001',
  enrolmentPinImmutable: 'ZF002',
} as const

/** The audit actions this module writes. Named, so a coverage test can enumerate them. */
export const FLOW_AUDIT_ACTIONS = {
  published: 'flow.definition_published',
  enrolled: 'flow.enrolled',
  ended: 'flow.enrolment_ended',
} as const

function refuse(
  refusal: FlowWriteRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AppError(refusal === 'flow_not_found' ? 'not_found' : 'conflict', message, {
    details: { ...details, refusal },
  })
}

/** The named refusal carried on an error this module raised, or null. */
export function flowRefusalOf(err: unknown): FlowWriteRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' && (FLOW_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as FlowWriteRefusal)
    : null
}

// ------------------------------------------------------------------------------------------------
// The injected validator
// ------------------------------------------------------------------------------------------------

/**
 * `validateFlowDefinition` from `@berelax/core`, injected.
 *
 * A structural MIRROR rather than a reduced shape of its own: core's result carries more facts than this
 * names, and a function returning more is assignable to one returning less, so the real validator goes in
 * with no adapter. An adapter is where the class check would come to be skipped.
 */
export type FlowDefinitionValidator = (candidate: unknown) =>
  | {
      readonly ok: true
      /** The canonical bytes. Stored as `jsonb`; the form is invariant under jsonb normalisation. */
      readonly canonical: string
      readonly facts: {
        readonly key: string
        readonly dslVersion: number
        readonly nodeCount: number
      }
    }
  | {
      readonly ok: false
      readonly refusals: readonly {
        readonly rule: string
        readonly at: string | null
        readonly detail: string
      }[]
    }

export interface FlowDeps {
  readonly validate?: FlowDefinitionValidator
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

export interface FlowRow {
  readonly id: string
  readonly flowKey: string
  readonly title: string
  readonly isActive: boolean
}

export async function readFlowByKey(sql: Sql, flowKey: string): Promise<FlowRow | null> {
  const [row] = await sql<
    { id: string; flow_key: string; title: string; is_active: boolean }[]
  >`select id, flow_key, title, is_active from flow where flow_key = ${flowKey}`
  return row === undefined
    ? null
    : { id: row.id, flowKey: row.flow_key, title: row.title, isActive: row.is_active }
}

/**
 * The live version of a flow, which is `max(version)` and is not stored anywhere.
 *
 * Derived rather than held in a column on purpose: a `live_version` column is a second statement of a
 * fact the rows already carry, and the first publish that failed half way would leave the two
 * disagreeing about which document the next enrolment gets.
 */
export async function readLiveFlowVersion(sql: Sql, flowKey: string): Promise<number | null> {
  const [row] = await sql<{ version: number | null }[]>`
    select max(d.version) as version
      from flow_definition d
      join flow f on f.id = d.flow_id
     where f.flow_key = ${flowKey}
  `
  return row?.version ?? null
}

export interface FlowDefinitionRow {
  readonly flowId: string
  readonly flowKey: string
  readonly version: number
  readonly dslVersion: number
  readonly nodeCount: number
  readonly definition: unknown
  readonly publishedBy: string
}

export async function readFlowDefinition(
  sql: Sql,
  flowKey: string,
  version: number,
): Promise<FlowDefinitionRow | null> {
  const [row] = await sql<
    {
      flow_id: string
      flow_key: string
      version: number
      dsl_version: number
      node_count: number
      definition: unknown
      published_by: string
    }[]
  >`
    select d.flow_id, f.flow_key, d.version, d.dsl_version, d.node_count, d.definition,
           d.published_by
      from flow_definition d
      join flow f on f.id = d.flow_id
     where f.flow_key = ${flowKey} and d.version = ${version}
  `
  return row === undefined ? null : asDefinitionRow(row)
}

const asDefinitionRow = (row: {
  flow_id: string
  flow_key: string
  version: number
  dsl_version: number
  node_count: number
  definition: unknown
  published_by: string
}): FlowDefinitionRow => ({
  flowId: row.flow_id,
  flowKey: row.flow_key,
  version: row.version,
  dslVersion: row.dsl_version,
  nodeCount: row.node_count,
  definition: row.definition,
  publishedBy: row.published_by,
})

export interface PinnedEnrolmentRead {
  readonly enrolmentId: string
  readonly customerId: string
  readonly status: string
  /** The version this enrolment is pinned to — the one that governs it, whatever has been published since. */
  readonly pinnedVersion: number
  /** `max(version)` for the same flow, so a caller can see the two differ without a second query. */
  readonly liveVersion: number
  readonly definition: unknown
}

/**
 * The document an enrolment is governed by: the PINNED version's, reached through the pin itself.
 *
 * The join is on `(flow_id, definition_version)` — the composite foreign key — and not on `flow_id` plus
 * `max(version)`, which is the query that would make every one of this unit's guarantees ornamental. It
 * returns the live version beside the pinned one so a caller can SEE that they differ; the interpreter
 * (C-AUTO-07) reads the pinned document and nothing else.
 */
export async function readEnrolmentPinnedDefinition(
  sql: Sql,
  enrolmentId: string,
): Promise<PinnedEnrolmentRead | null> {
  const [row] = await sql<
    {
      id: string
      customer_id: string
      status: string
      pinned_version: number
      live_version: number
      definition: unknown
    }[]
  >`
    select e.id,
           e.customer_id,
           e.status::text as status,
           d.version                                       as pinned_version,
           (select max(l.version) from flow_definition l
             where l.flow_id = e.flow_id)                   as live_version,
           d.definition
      from flow_enrolment e
      join flow_definition d
        on d.flow_id = e.flow_id and d.version = e.definition_version
     where e.id = ${enrolmentId}
  `
  return row === undefined
    ? null
    : {
        enrolmentId: row.id,
        customerId: row.customer_id,
        status: row.status,
        pinnedVersion: row.pinned_version,
        liveVersion: row.live_version,
        definition: row.definition,
      }
}

/**
 * How many enrolments sit on one version, counted in SQL.
 *
 * In SQL and never through a capped reader, which is `settings-store.itest.ts`'s recorded failure (brief
 * rule 12): a `limit` is right for a panel and wrong for a count, and a count that pins at the limit
 * reads as a smaller number rather than as an error. C-AUTO-09 displays this figure before saving an
 * edit, so it is the figure that has to be right.
 */
export async function countEnrolmentsOnVersion(
  sql: Sql,
  flowId: string,
  version: number,
  options: { readonly activeOnly?: boolean } = {},
): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n
      from flow_enrolment
     where flow_id = ${flowId}
       and definition_version = ${version}
       and (${options.activeOnly ?? false} = false or status = 'active')
  `
  return Number(row?.n ?? '0')
}

// ------------------------------------------------------------------------------------------------
// Publishing
// ------------------------------------------------------------------------------------------------

export interface PublishFlowInput {
  readonly flowKey: string
  /** Used only when the flow row does not exist yet. An existing flow keeps its title. */
  readonly title: string
  readonly definition: unknown
  readonly publishedBy: string
}

export interface PublishedFlowVersion {
  readonly flowId: string
  readonly flowKey: string
  readonly version: number
  readonly dslVersion: number
  readonly nodeCount: number
  /**
   * How many ACTIVE enrolments remain on the version this one supersedes — 0 on a first publish.
   *
   * Active rather than all, and that is the whole meaning of the figure: C-AUTO-09 states "the enrolments
   * that will remain on the current version" before an operator saves an edit, and an enrolment that has
   * already completed is not going anywhere. Counting every row would inflate the number every time the
   * flow ran, which makes the one figure an operator uses to decide whether to publish grow for a reason
   * that has nothing to do with the decision.
   *
   * Returned by the publish rather than looked up afterwards because it is the same transaction's answer:
   * a figure read after the commit is a figure that has already changed.
   */
  readonly activeEnrolmentsOnPreviousVersion: number
}

export async function publishFlowDefinition(
  uow: UnitOfWork,
  input: PublishFlowInput,
  deps: FlowDeps,
): Promise<PublishedFlowVersion> {
  const { validate } = deps
  if (validate === undefined) {
    refuse(
      'definition_not_validated',
      'No validator was injected, so the definition was not checked. `packages/db` may not import ' +
        '`@berelax/core`, so the rules have to be passed in — and a definition published without them ' +
        'is a flow that fails when it runs, for the enrolments already pinned to it.',
      { flowKey: input.flowKey },
    )
  }

  const verdict = validate(input.definition)
  if (!verdict.ok) {
    refuse('definition_invalid', 'The definition was refused by the validator.', {
      flowKey: input.flowKey,
      rules: verdict.refusals.map((refusal) => refusal.rule),
      detail: verdict.refusals.map(
        (refusal) => `${refusal.rule} at ${refusal.at ?? 'the document'}`,
      ),
    })
  }

  if (verdict.facts.key !== input.flowKey) {
    refuse(
      'definition_key_does_not_match_flow',
      `The document declares key "${verdict.facts.key}" and it is being published to ` +
        `"${input.flowKey}". flow_definition holds no key column, so nothing downstream could tell the ` +
        'two apart afterwards.',
      { flowKey: input.flowKey, documentKey: verdict.facts.key },
    )
  }

  const { sql } = uow
  // Create the flow if this is its first version. `on conflict do nothing` rather than a read-then-write:
  // two first publishes racing would both find nothing and the second would fail on the unique index,
  // which is a 23505 rather than a named refusal.
  await sql`
    insert into flow (flow_key, title, created_by)
    values (${input.flowKey}, ${input.title}, ${input.publishedBy})
    on conflict (flow_key) do nothing
  `
  // THE lock. Every publish for this flow serialises here, so `max(version) + 1` cannot be read twice.
  // Without it two publishes both write version N+1 and one of them loses on the primary key — which is
  // the correct outcome but reaches the operator as a constraint name rather than as "somebody else just
  // published".
  const [locked] = await sql<{ id: string }[]>`
    select id from flow where flow_key = ${input.flowKey} for update
  `
  if (locked === undefined) {
    refuse('flow_not_found', `No flow is called "${input.flowKey}".`, { flowKey: input.flowKey })
  }
  const flowId = locked.id

  const [previous] = await sql<{ version: number | null }[]>`
    select max(version) as version from flow_definition where flow_id = ${flowId}
  `
  const previousVersion = previous?.version ?? null
  const version = (previousVersion ?? 0) + 1

  await sql`
    insert into flow_definition (flow_id, version, dsl_version, definition, published_by)
    values (
      ${flowId}, ${version}, ${verdict.facts.dslVersion},
      ${sql.json(JSON.parse(verdict.canonical) as never)}, ${input.publishedBy}
    )
  `

  const activeEnrolmentsOnPreviousVersion =
    previousVersion === null
      ? 0
      : await countEnrolmentsOnVersion(sql, flowId, previousVersion, { activeOnly: true })

  await uow.audit.record({
    action: FLOW_AUDIT_ACTIONS.published,
    entityType: 'flow_definition',
    entityId: `${flowId}:${version}`,
    operation: 'create',
    after: {
      flowKey: input.flowKey,
      version,
      supersedes: previousVersion,
      nodeCount: verdict.facts.nodeCount,
      activeEnrolmentsOnPreviousVersion,
    },
  })

  return {
    flowId,
    flowKey: input.flowKey,
    version,
    dslVersion: verdict.facts.dslVersion,
    nodeCount: verdict.facts.nodeCount,
    activeEnrolmentsOnPreviousVersion,
  }
}

// ------------------------------------------------------------------------------------------------
// Enrolling
// ------------------------------------------------------------------------------------------------

export interface EnrolInput {
  readonly flowKey: string
  readonly customerId: string
  readonly createdBy: string
  /**
   * When the enrolment happened, from an injected clock.
   *
   * Explicit rather than left to the column's `now()` default, for the reason `suppression`'s mirror
   * states about its own four instants: `flow_enrolment_ends_after_it_starts` is an ORDERING constraint,
   * and an ordering asserted against the server clock cannot be tested under a frozen one — the test
   * either freezes time and writes a row the constraint refuses, or stops asserting the ordering.
   */
  readonly at: Date
}

export interface Enrolment {
  readonly enrolmentId: string
  readonly flowId: string
  /** The version resolved at enrolment time and pinned. Nothing re-resolves it afterwards. */
  readonly pinnedVersion: number
}

/**
 * Enrols one contact on the version that is live NOW, and pins it.
 *
 * This is the narrow write, not the enrolment API: the per-flow enrolment cap, the already-enrolled
 * outcome, the idempotency key and the trigger plumbing are C-AUTO-07's, which builds on this row. What
 * is here is the part that must be right before any of that exists — the version is read once, written
 * into the row, and never resolved again.
 */
export async function enrolOnLiveVersion(uow: UnitOfWork, input: EnrolInput): Promise<Enrolment> {
  const { sql } = uow
  const [flow] = await sql<{ id: string; is_active: boolean }[]>`
    select id, is_active from flow where flow_key = ${input.flowKey}
  `
  if (flow === undefined) {
    refuse('flow_not_found', `No flow is called "${input.flowKey}".`, { flowKey: input.flowKey })
  }
  if (!flow.is_active) {
    refuse(
      'flow_not_active',
      `Flow "${input.flowKey}" is not accepting enrolments. A flow is inactive until somebody enables ` +
        'it, so a publish cannot start messaging anybody by itself.',
      { flowKey: input.flowKey },
    )
  }
  const [live] = await sql<{ version: number | null }[]>`
    select max(version) as version from flow_definition where flow_id = ${flow.id}
  `
  const pinnedVersion = live?.version ?? null
  if (pinnedVersion === null) {
    refuse(
      'flow_has_no_published_version',
      `Flow "${input.flowKey}" has no published version, so there is nothing for an enrolment to pin.`,
      { flowKey: input.flowKey },
    )
  }

  const [row] = await sql<{ id: string }[]>`
    insert into flow_enrolment (flow_id, definition_version, customer_id, enrolled_at, created_by)
    values (${flow.id}, ${pinnedVersion}, ${input.customerId}, ${input.at}, ${input.createdBy})
    returning id
  `
  const enrolmentId = (row as { id: string }).id

  await uow.audit.record({
    action: FLOW_AUDIT_ACTIONS.enrolled,
    entityType: 'flow_enrolment',
    entityId: enrolmentId,
    operation: 'create',
    after: { flowKey: input.flowKey, pinnedVersion, customerId: input.customerId },
  })

  return { enrolmentId, flowId: flow.id, pinnedVersion }
}

export interface EndEnrolmentInput {
  readonly enrolmentId: string
  readonly status: 'completed' | 'cancelled'
  readonly reason: string
  /** From an injected clock. `now()` in SQL would make every ordering assertion untestable. */
  readonly at: Date
}

/**
 * Ends an enrolment: a status change, and the proof that the pin's immutability is column-level.
 *
 * `flow_definition` refuses every UPDATE; `flow_enrolment` refuses only a change to `(flow_id,
 * definition_version)`. If the enrolment table had been made append-only in the same way, an enrolment
 * could never finish — which is why the two tables carry different rules and why this function exists to
 * show that the difference is deliberate.
 */
export async function endFlowEnrolment(uow: UnitOfWork, input: EndEnrolmentInput): Promise<void> {
  const { sql } = uow
  const [row] = await sql<{ status: string }[]>`
    select status::text as status from flow_enrolment where id = ${input.enrolmentId} for update
  `
  if (row === undefined) {
    refuse('enrolment_not_found', `No enrolment is called "${input.enrolmentId}".`, {
      enrolmentId: input.enrolmentId,
    })
  }
  if (row.status !== 'active') {
    refuse(
      'enrolment_not_active',
      `The enrolment is already ${row.status}. A second ending would overwrite the first one's reason, ` +
        'and the first one is the record of why it stopped.',
      { enrolmentId: input.enrolmentId, status: row.status },
    )
  }

  await sql`
    update flow_enrolment
       set status = ${input.status}::flow_enrolment_status,
           ended_at = ${input.at},
           ended_reason = ${input.reason}
     where id = ${input.enrolmentId}
  `

  await uow.audit.record({
    action: FLOW_AUDIT_ACTIONS.ended,
    entityType: 'flow_enrolment',
    entityId: input.enrolmentId,
    operation: 'update',
    before: { status: row.status },
    after: { status: input.status, reason: input.reason },
  })
}

/** Whether a flow may take new enrolments. Separate from publishing, on purpose — see 0070's header. */
export async function setFlowActive(
  uow: UnitOfWork,
  flowKey: string,
  isActive: boolean,
): Promise<void> {
  const { sql } = uow
  const [row] = await sql<{ id: string; is_active: boolean }[]>`
    select id, is_active from flow where flow_key = ${flowKey} for update
  `
  if (row === undefined) {
    refuse('flow_not_found', `No flow is called "${flowKey}".`, { flowKey })
  }
  await sql`update flow set is_active = ${isActive} where id = ${row.id}`
  await uow.audit.record({
    action: 'flow.activation_changed',
    entityType: 'flow',
    entityId: row.id,
    operation: 'update',
    before: { isActive: row.is_active },
    after: { isActive },
  })
}
