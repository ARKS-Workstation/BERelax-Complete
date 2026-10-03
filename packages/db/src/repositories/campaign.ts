import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * Segments, campaigns, and the spend cap the DATABASE enforces.
 *
 * C-AUTO-10. Two writes carry the whole unit, and both are single SQL statements rather than a read
 * followed by a write:
 *
 *   - **{@link claimCampaignRecipient}** calls `claim_campaign_recipient`, which takes the campaign row's
 *     lock, reserves the estimate against `cap_fils` and claims the next pending recipient in one
 *     statement. There is no instant at which two workers have both read a spend and neither has written
 *     one, which is the only form in which a cap is a cap. `CampaignSpend` in
 *     `packages/messaging/src/send.ts` keeps its per-message check and is handed the figures THIS reads,
 *     so the choke point still refuses `campaign_cap_exceeded` by name and there is one statement of the
 *     cap rather than two.
 *   - **{@link settleCampaignRecipient}** calls `settle_campaign_recipient`, which records what the
 *     provider accepted and releases the difference against the reservation. The cap is enforced against
 *     the estimate — before the send, because an SMS cannot be un-sent — and reported against the actual.
 *
 * ## Why the compiled query is INJECTED
 *
 * `compileSegment` lives in `@berelax/core` (`automation/segment-compile.ts`) and this package may not
 * import it: the dependency runs core <- db and never back (brief rule 4). So {@link recountSegment}
 * takes the compiled `{ text, values }` pair, and with NO pair it refuses by name rather than counting
 * everybody. A recount that silently became `select count(*) from customer` is the failure mode a
 * recipient list cannot have, because the number it produces is larger and looks like success.
 *
 * The pair is parameterised — `$1…$n` with the values bound by the driver — so nothing a segment author
 * wrote reaches the text. That is `customer_segment.definition`'s own reason for being a document rather
 * than SQL.
 */

// ------------------------------------------------------------------------------------------------
// Refusals and the private SQLSTATEs
// ------------------------------------------------------------------------------------------------

export const CAMPAIGN_REFUSALS = [
  'segment_not_found',
  'campaign_not_found',
  /** No compiled query was injected, so nothing enumerated the segment. Fail closed. */
  'segment_not_compiled',
  /** The database refused the claim: the campaign is not running. ZY751. */
  'campaign_not_claimable',
  /** The database refused the settlement: the recipient was not claimed. ZY752. */
  'recipient_not_claimed',
  /** Something outside the two functions tried to move the spend. ZY753. */
  'spend_has_one_pair_of_writers',
  /** The cap was lowered under the spend already recorded. ZY754. */
  'cap_below_recorded_spend',
  /** A sent row was edited or deleted. ZY755. */
  'sent_recipient_is_evidence',
] as const
export type CampaignRefusal = (typeof CAMPAIGN_REFUSALS)[number]

/**
 * The private SQLSTATEs 0154 raises.
 *
 * Private rather than `check_violation`, for 0061's and 0070's reason: 23514 is raised by every CHECK in
 * this schema, so a probe asserting it passes when the statement bounced off something else entirely —
 * and this table carries seven CHECKs of its own that a claim could plausibly hit.
 */
export const CAMPAIGN_SQLSTATE = {
  notClaimable: 'ZY751',
  notClaimed: 'ZY752',
  spendHasOnePairOfWriters: 'ZY753',
  capBelowSpend: 'ZY754',
  sentRecipientIsEvidence: 'ZY755',
} as const

/** The audit actions this module writes. Named, so a coverage test can enumerate them. */
export const CAMPAIGN_AUDIT_ACTIONS = {
  segmentRecounted: 'campaign.segment_recounted',
  launched: 'campaign.launched',
  halted: 'campaign.halted',
} as const

const SQLSTATE_TO_REFUSAL: Readonly<Record<string, CampaignRefusal>> = {
  ZY751: 'campaign_not_claimable',
  ZY752: 'recipient_not_claimed',
  ZY753: 'spend_has_one_pair_of_writers',
  ZY754: 'cap_below_recorded_spend',
  ZY755: 'sent_recipient_is_evidence',
}

function refuse(
  refusal: CampaignRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AppError(
    refusal === 'segment_not_found' || refusal === 'campaign_not_found' ? 'not_found' : 'conflict',
    message,
    { details: { ...details, refusal } },
  )
}

/** The named refusal carried on an error from this module, or on a raw driver error from 0154. */
export function campaignRefusalOf(err: unknown): CampaignRefusal | null {
  if (err instanceof AppError) {
    const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
    if (typeof refusal === 'string' && (CAMPAIGN_REFUSALS as readonly string[]).includes(refusal)) {
      return refusal as CampaignRefusal
    }
  }
  // The driver's own error, matched on the CODE alone. A translator that matched on the message would
  // report one rule's refusal as another's the first time a message was reworded — which is exactly what
  // ADR 0043 made the five characters the identity for.
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? (SQLSTATE_TO_REFUSAL[code] ?? null) : null
}

/**
 * The bound values of a compiled or composed query, in the shape `postgres.js` wants them.
 *
 * One cast in one place rather than four, and it is a cast about the TYPE and not about the safety:
 * `unsafe` names the text, not the parameters. Every value here still travels as a `$n` the driver binds,
 * which is why a segment definition can be authored by a marketing screen at all.
 */
const bound = (values: readonly unknown[]): never[] => values as never[]

// ------------------------------------------------------------------------------------------------
// Segments
// ------------------------------------------------------------------------------------------------

/**
 * `compileSegment(...).count` from `@berelax/core`, injected.
 *
 * A structural mirror rather than a shape of its own, for `FlowDefinitionValidator`'s stated reason: the
 * real compilation's result carries more than this names, and a value carrying more is assignable, so it
 * goes in with no adapter. An adapter is where a `where` clause would come to be dropped.
 */
export interface CompiledSegmentQuery {
  readonly text: string
  readonly values: readonly unknown[]
}

export interface SegmentRow {
  readonly id: string
  readonly segmentKey: string
  readonly title: string
  readonly definition: unknown
  readonly cachedCount: number | null
  /** ISO, or null. NOT NULL whenever the count is, by constraint. */
  readonly cachedCountAtIso: string | null
}

export async function readSegmentByKey(sql: Sql, segmentKey: string): Promise<SegmentRow | null> {
  const [row] = await sql<SegmentRow[]>`
    select id, segment_key as "segmentKey", title, definition,
           cached_count as "cachedCount",
           to_char(cached_count_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "cachedCountAtIso"
      from customer_segment
     where segment_key = ${segmentKey}
  `
  return row ?? null
}

export interface CreateSegmentInput {
  readonly segmentKey: string
  readonly title: string
  /**
   * The definition document, as `serialiseSegmentDefinition` produced it and `JSON.parse` read it back.
   *
   * The PARSED document and not the canonical string, and that is not a style choice: a string parameter
   * cast with `::jsonb` through `postgres.js` stores a jsonb **string scalar** rather than an object, so
   * `definition -> 'terms'` is null and `term_count` — a GENERATED ALWAYS column over it — violates its
   * own NOT NULL. The insert failed loudly, which is the right failure and the reason the generated
   * column is there. `sql.json` is the one way to hand this driver a document.
   *
   * Nothing is lost by parsing: jsonb normalises key order itself, which is `flow_definition.definition`'s
   * own note — the canonical form is invariant under it.
   */
  readonly definition: unknown
  readonly createdBy: string
  readonly at: Date
}

export async function createSegment(uow: UnitOfWork, input: CreateSegmentInput): Promise<string> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into customer_segment (segment_key, title, definition, created_by, created_at, updated_at)
    values (${input.segmentKey}, ${input.title}, ${uow.sql.json(input.definition as never)},
            ${input.createdBy}, ${input.at}, ${input.at})
    returning id
  `
  if (row === undefined) refuse('segment_not_found', 'The segment insert returned no row.')
  return row.id
}

export interface SegmentRecount {
  readonly count: number
  readonly countedAtIso: string
}

/**
 * Re-enumerate a segment and write the count WITH its instant, in one statement.
 *
 * The count and the timestamp move together because `customer_segment_cached_count_is_dated` requires it,
 * and the constraint exists because a count with no instant is a number beside a send button with
 * nothing saying how stale it is.
 *
 * The count is taken by RUNNING the compiled query rather than by reading a maintained counter. A
 * maintained counter is a second statement of the fact and drifts on exactly the writes nobody
 * instrumented — a lifecycle transition, a merge, an erasure — and the acceptance line is that the cached
 * count equals a live recount after a seeded change. That equality is only worth asserting if the cached
 * count is PRODUCED by the live recount.
 */
export async function recountSegment(
  uow: UnitOfWork,
  input: {
    readonly segmentId: string
    readonly at: Date
    readonly compiled?: CompiledSegmentQuery
  },
): Promise<SegmentRecount> {
  if (input.compiled === undefined) {
    refuse(
      'segment_not_compiled',
      'recountSegment was called with no compiled query, so there is nothing to count. Compile the ' +
        'stored definition with compileSegment() in @berelax/core and pass the `count` query. Refusing ' +
        'rather than counting every contact: a recount that quietly became "select count(*) from ' +
        'customer" produces a LARGER number and reads as success, and the number it produces is what a ' +
        'campaign estimate is multiplied by.',
      { segmentId: input.segmentId },
    )
  }

  // `unsafe` is the only way to run a compiled query, and the name is about the TEXT rather than the
  // values: the text comes from `compileSegment`, which assembles it from its own closed registry, and
  // every value travels as a `$n` parameter the driver binds. A `sql` template literal cannot express a
  // query whose shape is not known at compile time, which is exactly what a segment is.
  const counted = await uow.sql.unsafe(input.compiled.text, bound(input.compiled.values))
  const first = (counted as unknown as readonly { count?: unknown }[])[0]
  const count = typeof first?.count === 'number' ? first.count : Number(first?.count)
  if (!Number.isInteger(count)) {
    refuse(
      'segment_not_compiled',
      `The compiled count query returned ${String(first?.count)}, which is not a whole number of ` +
        'contacts. A segment count is a row count; anything else means the injected query was not the ' +
        'count half of a compilation.',
      { segmentId: input.segmentId },
    )
  }

  const [row] = await uow.sql<{ countedAtIso: string }[]>`
    update customer_segment
       set cached_count = ${count}, cached_count_at = ${input.at}, updated_at = ${input.at}
     where id = ${input.segmentId}::uuid
    returning to_char(cached_count_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "countedAtIso"
  `
  if (row === undefined) {
    refuse('segment_not_found', `No segment with id ${input.segmentId}.`, {
      segmentId: input.segmentId,
    })
  }

  await uow.audit.record({
    action: CAMPAIGN_AUDIT_ACTIONS.segmentRecounted,
    entityType: 'customer_segment',
    entityId: input.segmentId,
    operation: 'update',
    after: { count, countedAtIso: row.countedAtIso },
  })

  return { count, countedAtIso: row.countedAtIso }
}

// ------------------------------------------------------------------------------------------------
// Campaigns
// ------------------------------------------------------------------------------------------------

export interface CampaignRow {
  readonly id: string
  readonly campaignKey: string
  readonly title: string
  readonly segmentId: string
  readonly templateKey: string
  readonly channel: 'sms' | 'email' | 'whatsapp'
  readonly state: 'draft' | 'scheduled' | 'running' | 'halted' | 'completed' | 'cancelled'
  readonly haltedReason: 'spend_cap_reached' | 'promotional_window_closed' | 'operator' | null
  readonly scheduledAtIso: string | null
  readonly estimatedRecipients: number | null
  readonly estimatedSegments: number | null
  readonly estimatedFils: number | null
  readonly capFils: number
  readonly spentFils: number
}

const CAMPAIGN_COLUMNS = `
  id, campaign_key as "campaignKey", title, segment_id as "segmentId",
  template_key as "templateKey", channel::text as channel, state::text as state,
  halted_reason::text as "haltedReason",
  to_char(scheduled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "scheduledAtIso",
  estimated_recipients as "estimatedRecipients", estimated_segments as "estimatedSegments",
  estimated_fils as "estimatedFils", cap_fils as "capFils", spent_fils as "spentFils"`

export async function readCampaignByKey(
  sql: Sql,
  campaignKey: string,
): Promise<CampaignRow | null> {
  const rows = (await sql.unsafe(
    `select ${CAMPAIGN_COLUMNS} from campaign where campaign_key = $1`,
    bound([campaignKey]),
  )) as unknown as CampaignRow[]
  return rows[0] ?? null
}

export interface CreateCampaignInput {
  readonly campaignKey: string
  readonly title: string
  readonly segmentId: string
  readonly templateKey: string
  readonly channel: 'sms' | 'email' | 'whatsapp'
  readonly capFils: number
  readonly createdBy: string
  readonly at: Date
}

export async function createCampaign(uow: UnitOfWork, input: CreateCampaignInput): Promise<string> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into campaign (campaign_key, title, segment_id, template_key, channel, cap_fils,
                          created_by, created_at, updated_at)
    values (${input.campaignKey}, ${input.title}, ${input.segmentId}::uuid, ${input.templateKey},
            ${input.channel}::message_channel, ${input.capFils}, ${input.createdBy},
            ${input.at}, ${input.at})
    returning id
  `
  if (row === undefined) refuse('campaign_not_found', 'The campaign insert returned no row.')
  return row.id
}

export interface LaunchCampaignInput {
  readonly campaignId: string
  /** The contacts, in the order they will be claimed. Already filtered by consent and suppression. */
  readonly customerIds: readonly string[]
  /** The pre-launch estimate, stored so the actual can be reconciled against it to the fils. */
  readonly estimate: {
    readonly recipients: number
    readonly segmentsPerMessage: number
    readonly totalFils: number
  }
  /** The instant accepted by `scheduleCampaign` in `@berelax/core`. Null for "now". */
  readonly scheduledAt: Date | null
  readonly at: Date
}

/**
 * Enumerate the recipients and move the campaign to `running`, in one transaction.
 *
 * The recipient rows are written at LAUNCH and not discovered per send, and that is the decision the
 * acceptance arithmetic rests on: *"held + sent == total"* needs a total, and a total that is recomputed
 * from a live segment query changes under the campaign — a contact who lapses mid-send would leave the
 * denominator, and a halted campaign's own report would not add up.
 *
 * `position` is the enumeration order and is what makes "recipient 120 of 200" a fact about a row rather
 * than about whichever order a worker read them in.
 */
export async function launchCampaign(
  uow: UnitOfWork,
  input: LaunchCampaignInput,
): Promise<{ readonly total: number }> {
  if (input.customerIds.length !== input.estimate.recipients) {
    refuse(
      'campaign_not_claimable',
      `The estimate says ${input.estimate.recipients} recipient(s) and ${input.customerIds.length} ` +
        'contact(s) were handed over. The acceptance line is that the pre-launch estimate equals the ' +
        'outcome to the fils, and it cannot if the count the cost was multiplied from is not the list ' +
        'that will be enumerated.',
      { campaignId: input.campaignId },
    )
  }

  // One statement for every recipient. `unnest` with an ordinality, so `position` comes from the array's
  // own order rather than from a counter this function keeps — a counter is what makes a retry write a
  // second set of positions.
  await uow.sql`
    insert into campaign_recipient (campaign_id, customer_id, position, created_at)
    select ${input.campaignId}::uuid, customer_id::uuid, ordinality, ${input.at}
      from unnest(${input.customerIds as string[]}::text[]) with ordinality as t(customer_id, ordinality)
  `

  await uow.sql`
    update campaign
       set state = 'running',
           estimated_recipients = ${input.estimate.recipients},
           estimated_segments = ${input.estimate.segmentsPerMessage},
           estimated_fils = ${input.estimate.totalFils},
           scheduled_at = ${input.scheduledAt},
           launched_at = ${input.at},
           updated_at = ${input.at}
     where id = ${input.campaignId}::uuid
  `

  await uow.audit.record({
    action: CAMPAIGN_AUDIT_ACTIONS.launched,
    entityType: 'campaign',
    entityId: input.campaignId,
    operation: 'update',
    after: {
      recipients: input.estimate.recipients,
      segmentsPerMessage: input.estimate.segmentsPerMessage,
      estimatedFils: input.estimate.totalFils,
    },
  })

  return { total: input.customerIds.length }
}

export interface CampaignRecipientRow {
  readonly id: string
  readonly campaignId: string
  readonly customerId: string
  readonly position: number
  readonly state: 'pending' | 'claimed' | 'sent' | 'held' | 'failed'
  readonly reservedFils: number | null
  readonly costFils: number | null
  readonly segments: number | null
  readonly gateDecision: string | null
  readonly consentRecordId: string | null
  readonly heldReason: string | null
}

const RECIPIENT_COLUMNS = `
  id, campaign_id as "campaignId", customer_id as "customerId", position, state::text as state,
  reserved_fils as "reservedFils", cost_fils as "costFils", segments,
  gate_decision as "gateDecision", consent_record_id as "consentRecordId",
  held_reason as "heldReason"`

/**
 * Reserve an estimate against the cap and claim the next pending recipient, atomically.
 *
 * Returns the recipient it claimed, the recipient it HELD because the cap bound, or null when nothing is
 * pending. The caller tells the three apart by `state`, and that is deliberate: a worker that got
 * nothing back cannot distinguish "the cap bound" from "there was nothing left", and those are the two
 * answers a halted campaign has to give.
 */
export async function claimCampaignRecipient(
  sql: Sql,
  input: { readonly campaignId: string; readonly estimateFils: number },
): Promise<CampaignRecipientRow | null> {
  const rows = (await sql.unsafe(
    `select ${RECIPIENT_COLUMNS} from claim_campaign_recipient($1::uuid, $2::integer) as r
      where r.id is not null`,
    bound([input.campaignId, input.estimateFils]),
  )) as unknown as CampaignRecipientRow[]
  return rows[0] ?? null
}

export interface SettleRecipientInput {
  readonly recipientId: string
  readonly state: 'sent' | 'held' | 'failed'
  readonly costFils: number | null
  readonly segments: number | null
  /**
   * The gate's verdict, as the choke point's result named it. NOT NULL on a sent row, by constraint.
   *
   * The `SendResult`'s `kind` plus its `reason` where there is one — `sent`, `blocked:no_consent`,
   * `queued:queued_for_window`. One column rather than two, because the regulator's question is "on what
   * basis did this message go out", and a verdict split across two nullable columns is a question with
   * two places to look.
   */
  readonly gateDecision: string | null
  /** The `consent` row this send rested on. NOT NULL on a sent row, by constraint. */
  readonly consentRecordId: string | null
  readonly heldReason: string | null
}

/** Record what one claimed recipient actually cost, and release the difference. */
export async function settleCampaignRecipient(
  sql: Sql,
  input: SettleRecipientInput,
): Promise<CampaignRecipientRow> {
  const rows = (await sql.unsafe(
    `select ${RECIPIENT_COLUMNS}
       from settle_campaign_recipient($1::uuid, $2::campaign_recipient_state, $3::integer,
                                      $4::smallint, $5::text, $6::uuid, $7::text) as r`,
    bound([
      input.recipientId,
      input.state,
      input.costFils,
      input.segments,
      input.gateDecision,
      input.consentRecordId,
      input.heldReason,
    ]),
  )) as unknown as CampaignRecipientRow[]
  const row = rows[0]
  if (row === undefined) {
    refuse(
      'recipient_not_claimed',
      `settle_campaign_recipient returned no row for ${input.recipientId}.`,
    )
  }
  return row
}

export interface CampaignOutcome {
  readonly total: number
  readonly sent: number
  readonly held: number
  readonly failed: number
  readonly pending: number
  readonly spentFils: number
  readonly capFils: number
}

/**
 * How a campaign ended, in ONE query.
 *
 * `held + sent == total` is the arithmetic the acceptance line reads a halted campaign by, so every term
 * of it comes from one scan: three counts taken separately could be taken either side of a settlement,
 * and the sum would then be short or long by one with nothing saying which.
 */
export async function readCampaignOutcome(
  sql: Sql,
  campaignId: string,
): Promise<CampaignOutcome | null> {
  const [row] = await sql<CampaignOutcome[]>`
    select count(*)::int as total,
           count(*) filter (where r.state = 'sent')::int as sent,
           count(*) filter (where r.state = 'held')::int as held,
           count(*) filter (where r.state = 'failed')::int as failed,
           count(*) filter (where r.state in ('pending', 'claimed'))::int as pending,
           max(c.spent_fils)::int as "spentFils",
           max(c.cap_fils)::int as "capFils"
      from campaign c
      left join campaign_recipient r on r.campaign_id = c.id
     where c.id = ${campaignId}::uuid
     group by c.id
  `
  return row ?? null
}

/** Stop a running campaign at a boundary, leaving the remainder held and visible. */
export async function haltCampaign(
  uow: UnitOfWork,
  input: {
    readonly campaignId: string
    readonly reason: 'spend_cap_reached' | 'promotional_window_closed' | 'operator'
    readonly detail: string
    readonly at: Date
  },
): Promise<{ readonly held: number }> {
  // Every remaining pending row becomes held, in one statement, with the halt's own reason. A pending row
  // left behind would be claimed by the next worker, and the campaign would resume without anybody
  // deciding to resume it.
  const held = await uow.sql<{ id: string }[]>`
    update campaign_recipient
       set state = 'held', held_reason = ${input.reason}
     where campaign_id = ${input.campaignId}::uuid and state = 'pending'
    returning id
  `

  await uow.sql`
    update campaign
       set state = 'halted', halted_reason = ${input.reason}::campaign_halt_reason,
           halted_at = ${input.at}, updated_at = ${input.at}
     where id = ${input.campaignId}::uuid
  `

  await uow.audit.record({
    action: CAMPAIGN_AUDIT_ACTIONS.halted,
    entityType: 'campaign',
    entityId: input.campaignId,
    operation: 'update',
    after: { reason: input.reason, held: held.length, detail: input.detail },
  })

  return { held: held.length }
}
