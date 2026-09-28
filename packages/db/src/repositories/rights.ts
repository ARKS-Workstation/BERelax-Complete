import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { SQL_IDENTIFIER } from '../merge-participants.ts'
import { erasureCoverage, type ProbedColumnRow } from '../privacy-coverage.ts'
import type { UnitOfWork } from '../tx.ts'
import { recordSuppression, type SuppressionKeying } from './suppression.ts'

/**
 * The data-subject rights engine's writes (C-CRM-10), over 0085.
 *
 * ## The decisions arrive injected, because `packages/db` may not import `packages/core`
 *
 * The dependency runs core ← db, so the same seam `suppression.ts` uses twice is used here four times, and
 * in every case the permissive version is the dangerous one. There is no fallback for any of them: an
 * erasure that ran with a missing decider would do part of the work and report success.
 *
 *   - **{@link ErasureDeps.classify}** — `classifyErasureCoverage`. Without it nothing knows which tables
 *     hold the person, and an erasure over "the tables this file happens to name" is exactly the defect the
 *     probe exists to prevent.
 *   - **{@link ErasureDeps.pseudonymFor}** — `erasurePseudonym`. A missing one would leave the identity
 *     column holding the phone number.
 *   - **{@link ErasureDeps.planClinical}** — `planClinicalErasure`. A default in either direction is wrong:
 *     "destroy" defeats a retention obligation the profile records, and "retain" silently declines a right.
 *   - **{@link ErasureDeps.decideResponse}** — `decideRightsResponse`. A default of "issue" would produce a
 *     letter naming a supervisory authority this build does not have.
 *
 * ## The engine REFUSES when a column is unclassified
 *
 * {@link eraseSubject} runs the five catalogue probes at the start of every erasure and refuses
 * (`erasure_coverage_incomplete`) if any column they return has no rule. That is stronger than a test, and
 * deliberately so: a test catches it on the branch that added the table, and this catches it in production
 * on the day somebody deploys a migration whose classification was lost in a merge. The business would
 * rather an erasure fail loudly than complete while leaving the person reachable.
 *
 * ## The phone numbers are CAPTURED before anything is acted on, and that — not the step order — is what
 * makes the erasure safe
 *
 * `message` rows are found BY the recipient address (the table has no customer id at all) and the
 * suppression entry is keyed on an HMAC of the phone number, so both need a number the erasure is about to
 * destroy. {@link loadIdentities} reads every live record's number ONCE, before any statement runs, and
 * every later step works from that list.
 *
 * This paragraph claimed something stronger in its first draft — that pseudonymising the identity LAST was
 * part of the contract — and gate case 112j disproved it: reversing the order changes nothing, because the
 * numbers were already in hand. The ordering is kept because it reads in the order a person would do the
 * work, and the gate case now targets the capture instead, which is the thing that would actually break.
 * A comment defending a safeguard that is not there is worse than no comment: it tells the next person the
 * problem is solved somewhere it is not.
 *
 * ## A merged-away record is part of the same person
 *
 * An erasure naming a survivor must also erase every record merged INTO it. Those `customer` rows still
 * exist — a merge leaves a tombstone rather than deleting (0069) — and each still holds its own live phone
 * number. Erasing only the id the request named would leave the person reachable through a row the request
 * never mentioned, which is the failure mode of this whole unit in its quietest form. The chain is walked
 * recursively in SQL, because a survivor can itself have been merged into.
 */

// ------------------------------------------------------------------------------------------------
// Refusals
// ------------------------------------------------------------------------------------------------

export const RIGHTS_REFUSALS = [
  /** The catalogue returned a column no rule classifies. Nothing was changed. */
  'erasure_coverage_incomplete',
  /** A decider was not injected. Fail closed rather than doing part of the work. */
  'erasure_not_decided',
  /** An acting rule has no execution recipe in this module, or a recipe has no rule. */
  'erasure_recipe_mismatch',
  /** The named request does not exist, is not an erasure, or is not in progress. */
  'rights_request_not_actionable',
  /** No regulatory profile is in force, so nothing can say what was retained and why. */
  'rights_profile_absent',
  /** An export was asked for with no purpose stated. */
  'rights_export_purpose_absent',
] as const
export type RightsRefusal = (typeof RIGHTS_REFUSALS)[number]

/** SQLSTATEs 0085 raises, so a caller can tell one refusal from any other conflict. */
export const RIGHTS_SQLSTATE = {
  requestNotDeletable: 'ZY001',
  requestFrozenColumn: 'ZY002',
  transitionRefused: 'ZY003',
  recordImmutable: 'ZY004',
  dekDestructionImmutable: 'ZY005',
  clinicalNotAuthorised: 'ZY006',
} as const

function refuse(
  refusal: RightsRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AppError('invariant_violated', message, { details: { ...details, refusal } })
}

// ------------------------------------------------------------------------------------------------
// The execution recipes: what `packages/db` actually issues for each acting rule
// ------------------------------------------------------------------------------------------------

/**
 * How the subject is matched in a statement. Three values, and each exists for a table that needs it.
 *
 * `phone` is the one worth noticing: `otp_challenge`, `otp_phone_lock` and `message` have NO customer id,
 * so the only way to find a person's rows is the phone number itself — which is why the identity is
 * pseudonymised last.
 */
type SubjectKey = 'customer_id' | 'phone' | 'booking_of_customer'

interface ExecutionRecipe {
  /** The rule key in `packages/core/src/privacy/rights-policy.ts` this carries out. */
  readonly ruleKey: string
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly subjectKey: SubjectKey
  /** The column the subject is matched ON, which is not always the column being acted on. */
  readonly matchColumn: string
  readonly action: 'pseudonymise' | 'redact' | 'delete_row' | 'crypto_erase'
  /**
   * How the statement reaches the table. `statement` — the default — is a direct DML statement.
   *
   * `definer` means the application role may not issue it and it goes through
   * `public.erase_customer_workflow_rows`, which is SECURITY DEFINER and gated on an in-progress erasure
   * request. Declared on the recipe rather than decided in the executor because the recipe is where the
   * question "what carries this rule out" is already answered, and because the two tables that need it
   * (`flow_enrolment`, `customer_pipeline_card`) are indistinguishable from their neighbours in every way
   * except the privilege — so an executor deciding by name would be a rule nobody could see.
   */
  readonly via?: 'statement' | 'definer'
  /**
   * For `redact`: what replaces the value. `null` where the column admits it, and a stated marker where it
   * does not — a `not null` column blanked to the empty string reads as a message that was sent empty.
   */
  readonly redactTo?: 'null' | 'marker'
}

/**
 * The marker a `not null` column is redacted to.
 *
 * It names the operation rather than being a blank or a row of asterisks, so a reader of the row can tell
 * a redaction from data that was never there — which is brief rule 15's argument applied to an absence.
 */
export const REDACTION_MARKER = '[redacted under a data-subject erasure request]'

/**
 * The only tables `public.erase_customer_workflow_rows` will delete from, and it takes a BRANCH SELECTOR
 * rather than an identifier — so this list and the function's `if` have to agree. A third table means
 * editing 0085, which is the point: a SECURITY DEFINER delete should not be reachable by passing a string.
 */
const DEFINER_TARGETS: readonly string[] = Object.freeze([
  'flow_enrolment',
  'customer_pipeline_card',
])

const recipe = (r: ExecutionRecipe): ExecutionRecipe => Object.freeze(r)

/**
 * Freezes the recipes, refusing a malformed identifier before anything reaches `sql.unsafe`.
 *
 * The statements below interpolate a schema, a table and two column names, because a dynamic table name
 * cannot be bound as a parameter. So this is the boundary that makes that safe, and it is
 * `assertParticipantIsWellFormed`'s argument verbatim: every identifier is checked against
 * {@link SQL_IDENTIFIER} — the SAME constant the merge executor uses, imported rather than restated — and
 * the subject's id and phone number are always bound parameters and never interpolated.
 */
function recipeRegistry(recipes: readonly ExecutionRecipe[]): readonly ExecutionRecipe[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const r of recipes) {
    for (const identifier of [r.schema, r.table, r.column, r.matchColumn]) {
      if (!SQL_IDENTIFIER.test(identifier)) {
        problems.push(`${r.ruleKey}: "${identifier}" is not a bare lower-case SQL identifier`)
      }
    }
    if (r.action === 'redact' && r.redactTo === undefined) {
      problems.push(`${r.ruleKey}: a redaction must say what replaces the value`)
    }
    // `erase_customer_workflow_rows` holds two static DELETEs and admits no other target, so a recipe
    // routed through it that is not one of them would raise ZY008 mid-erasure. Refused here instead.
    if (r.via === 'definer' && !(r.action === 'delete_row' && DEFINER_TARGETS.includes(r.table))) {
      problems.push(
        `${r.ruleKey}: only a delete of ${DEFINER_TARGETS.join(' or ')} goes through the definer function`,
      )
    }
    if (seen.has(r.ruleKey)) problems.push(`${r.ruleKey}: declared more than once`)
    seen.add(r.ruleKey)
  }
  if (problems.length > 0) {
    throw new AppError(
      'invariant_violated',
      `The erasure execution recipes are not well formed:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
      { details: { problems, refusal: 'erasure_recipe_mismatch' } },
    )
  }
  return Object.freeze(recipes)
}

/**
 * One recipe per acting rule. Nothing here decides anything; the decisions are in `packages/core`.
 *
 * `assertRecipesMatchRules` holds this list and the rule registry equal in both directions, so an acting
 * rule with no recipe and a recipe with no rule are both refusals rather than a silent no-op. The
 * asymmetry that would otherwise bite: adding a rule is the natural half to remember, and the statement
 * that carries it out is the half that gets forgotten — and a rule with no statement reports its rows as
 * acted on while changing nothing.
 */
export const EXECUTION_RECIPES: readonly ExecutionRecipe[] = recipeRegistry([
  // Identity. `phone_e164` is last in the RUN, not last in this list — see `eraseSubject`.
  recipe({
    ruleKey: 'public.customer.phone_e164',
    schema: 'public',
    table: 'customer',
    column: 'phone_e164',
    subjectKey: 'customer_id',
    matchColumn: 'id',
    action: 'pseudonymise',
  }),
  recipe({
    ruleKey: 'public.customer.display_name',
    schema: 'public',
    table: 'customer',
    column: 'display_name',
    subjectKey: 'customer_id',
    matchColumn: 'id',
    action: 'redact',
    redactTo: 'null',
  }),
  recipe({
    ruleKey: 'public.customer.name_match_key',
    schema: 'public',
    table: 'customer',
    column: 'name_match_key',
    subjectKey: 'customer_id',
    matchColumn: 'id',
    action: 'redact',
    redactTo: 'null',
  }),
  recipe({
    ruleKey: 'public.customer.phone_verified_at',
    schema: 'public',
    table: 'customer',
    column: 'phone_verified_at',
    subjectKey: 'customer_id',
    matchColumn: 'id',
    action: 'redact',
    redactTo: 'null',
  }),
  recipe({
    ruleKey: 'public.customer.notes',
    schema: 'public',
    table: 'customer',
    column: 'notes',
    subjectKey: 'customer_id',
    matchColumn: 'id',
    action: 'redact',
    redactTo: 'null',
  }),
  recipe({
    ruleKey: 'public.booking.notes',
    schema: 'public',
    table: 'booking',
    column: 'notes',
    subjectKey: 'customer_id',
    matchColumn: 'customer_id',
    action: 'redact',
    redactTo: 'null',
  }),

  // Contact channels. The three tables with no customer id are matched on the number itself.
  recipe({
    ruleKey: 'public.otp_challenge.phone_e164',
    schema: 'public',
    table: 'otp_challenge',
    column: 'phone_e164',
    subjectKey: 'phone',
    matchColumn: 'phone_e164',
    action: 'delete_row',
  }),
  recipe({
    ruleKey: 'public.otp_phone_lock.phone_e164',
    schema: 'public',
    table: 'otp_phone_lock',
    column: 'phone_e164',
    subjectKey: 'phone',
    matchColumn: 'phone_e164',
    action: 'delete_row',
  }),
  recipe({
    ruleKey: 'public.message.recipient',
    schema: 'public',
    table: 'message',
    column: 'recipient',
    subjectKey: 'phone',
    matchColumn: 'recipient',
    action: 'redact',
    redactTo: 'marker',
  }),
  recipe({
    ruleKey: 'public.message.body',
    schema: 'public',
    table: 'message',
    column: 'body',
    subjectKey: 'phone',
    matchColumn: 'recipient',
    action: 'redact',
    redactTo: 'marker',
  }),
  recipe({
    ruleKey: 'public.message.subject',
    schema: 'public',
    table: 'message',
    column: 'subject',
    subjectKey: 'phone',
    matchColumn: 'recipient',
    action: 'redact',
    redactTo: 'null',
  }),
  recipe({
    ruleKey: 'public.message.body_html',
    schema: 'public',
    table: 'message',
    column: 'body_html',
    subjectKey: 'phone',
    matchColumn: 'recipient',
    action: 'redact',
    redactTo: 'null',
  }),
  recipe({
    ruleKey: 'public.booking_session.customer_id',
    schema: 'public',
    table: 'booking_session',
    column: 'customer_id',
    subjectKey: 'customer_id',
    matchColumn: 'customer_id',
    action: 'delete_row',
  }),

  // Credentials. DELETED and not expired-in-place: 0067 revokes UPDATE on this table from `berelax_app`
  // deliberately and names DELETE as the revocation path, so the UPDATE this recipe used to issue raised
  // `permission denied for table booking_manage_grant` the first time the erasure ran as the application
  // role. `subjectKey` is the reason this recipe is not like its neighbours: the table has no customer id
  // (that is why the credential probe exists at all), so the subject is reached through their bookings.
  recipe({
    ruleKey: 'public.booking_manage_grant.token_sha256',
    schema: 'public',
    table: 'booking_manage_grant',
    column: 'token_sha256',
    subjectKey: 'booking_of_customer',
    matchColumn: 'booking_id',
    action: 'delete_row',
  }),

  // Operational rows that are forward-looking or hold nothing but opinions.
  recipe({
    ruleKey: 'public.waitlist.customer_id',
    schema: 'public',
    table: 'waitlist',
    column: 'customer_id',
    subjectKey: 'customer_id',
    matchColumn: 'customer_id',
    action: 'delete_row',
  }),
  // `via: 'definer'` on both of these, and it is a privilege fact rather than a preference. 0070 and 0077
  // each revoke DELETE on their table from `berelax_app` with the same stated reason — that removal happens
  // by cascade from `customer` — and an erasure cannot delete `customer`, because a retained tax invoice
  // references it. So the cascade they relied on never runs and the direct DELETE raises `permission
  // denied` for the role the engine actually runs as. The app-role integration case found both.
  recipe({
    ruleKey: 'public.flow_enrolment.customer_id',
    schema: 'public',
    table: 'flow_enrolment',
    column: 'customer_id',
    subjectKey: 'customer_id',
    matchColumn: 'customer_id',
    action: 'delete_row',
    via: 'definer',
  }),
  recipe({
    ruleKey: 'public.customer_preference.customer_id',
    schema: 'public',
    table: 'customer_preference',
    column: 'customer_id',
    subjectKey: 'customer_id',
    matchColumn: 'customer_id',
    action: 'delete_row',
  }),
  recipe({
    ruleKey: 'public.customer_tag.customer_id',
    schema: 'public',
    table: 'customer_tag',
    column: 'customer_id',
    subjectKey: 'customer_id',
    matchColumn: 'customer_id',
    action: 'delete_row',
  }),
  recipe({
    ruleKey: 'public.customer_pipeline_card.customer_id',
    schema: 'public',
    table: 'customer_pipeline_card',
    column: 'customer_id',
    subjectKey: 'customer_id',
    matchColumn: 'customer_id',
    action: 'delete_row',
    via: 'definer',
  }),

  // Clinical. These three go through the SECURITY DEFINER functions, not through a statement here — the
  // application role holds no privilege on the schema (0009). They are declared so the recipe set and the
  // rule set can be held equal, and `eraseSubject` routes them.
  recipe({
    ruleKey: 'clinical.intake_submission.customer_id',
    schema: 'clinical',
    table: 'intake_submission',
    column: 'wrapped_data_key',
    subjectKey: 'customer_id',
    matchColumn: 'customer_id',
    action: 'crypto_erase',
  }),
  recipe({
    ruleKey: 'clinical.treatment_note.customer_id',
    schema: 'clinical',
    table: 'treatment_note',
    column: 'wrapped_data_key',
    subjectKey: 'customer_id',
    matchColumn: 'customer_id',
    action: 'crypto_erase',
  }),
  recipe({
    ruleKey: 'clinical.contraindication_flag.customer_id',
    schema: 'clinical',
    table: 'contraindication_flag',
    column: 'customer_id',
    subjectKey: 'customer_id',
    matchColumn: 'customer_id',
    action: 'delete_row',
  }),
])

/** Every acting action. A rule with one of these needs a recipe; a rule without one must not have any. */
const ACTING_ACTIONS: readonly string[] = Object.freeze([
  'pseudonymise',
  'redact',
  'delete_row',
  'crypto_erase',
])

/**
 * Every action that leaves READABLE DATA ABOUT THE SUBJECT in place, and only those.
 *
 * The distinction decides what `rows_retained` counts, and getting it wrong cost a rolled-back erasure.
 * `inherits_parent` and `not_customer_data` are NOT retentions: the first says whatever happened to the
 * parent governs this column, and the second says the rows are not about a data subject at all
 * (`invoice.issuer_phone` is the salon's own number). Counting either as retained demanded a reason for
 * keeping data that either is not there or was never theirs — and the database refused it, correctly,
 * because the only sentence available was the maintainer's prose.
 *
 * So a line for one of those actions reports zeros: the column was classified, and this erasure did nothing
 * to it directly. `rows_retained > 0` then means exactly one thing — readable data about this person stayed
 * in this column under a named retention — which is precisely what has to carry a reason.
 *
 * Duplicated from `isRetainingAction` in `@berelax/core` because `packages/db` may not import it, and
 * `packages/fixtures/src/rights.itest.ts` asserts the two lists are equal.
 */
export const RETAINING_ERASURE_ACTIONS: readonly string[] = Object.freeze([
  'retain_statutory',
  'retain_append_only',
  'retain_for_subject',
  'retain_legitimate_interest',
])

/**
 * Holds the rule registry and the recipe list equal, in both directions.
 *
 * A function taking the rules as an argument rather than an assertion at module load, because `packages/db`
 * cannot import `packages/core` — so the equality can only be checked where both are visible, which is
 * `packages/fixtures` (brief rule 4) and the engine's own entry point. Both call it.
 */
export function assertRecipesMatchRules(
  rules: readonly { readonly key: string; readonly action: string }[],
): void {
  const recipeKeys = new Set(EXECUTION_RECIPES.map((r) => r.ruleKey))
  const actingKeys = new Set(
    rules.filter((r) => ACTING_ACTIONS.includes(r.action)).map((r) => r.key),
  )
  const missingRecipe = [...actingKeys].filter((k) => !recipeKeys.has(k)).sort()
  const orphanRecipe = [...recipeKeys].filter((k) => !actingKeys.has(k)).sort()
  if (missingRecipe.length > 0 || orphanRecipe.length > 0) {
    refuse(
      'erasure_recipe_mismatch',
      'The erasure rules and the statements that carry them out disagree. Rules that act with no ' +
        `statement to do it: ${missingRecipe.join(', ') || '(none)'}. Statements for a rule that does ` +
        `not act: ${orphanRecipe.join(', ') || '(none)'}. A rule with no statement reports its rows as ` +
        'acted on while changing nothing, which is the quietest way for an erasure to be incomplete.',
      { missingRecipe, orphanRecipe },
    )
  }
}

// ------------------------------------------------------------------------------------------------
// Requests
// ------------------------------------------------------------------------------------------------

export interface RightsRequestInput {
  readonly requestType: 'export' | 'rectification' | 'erasure' | 'objection' | 'withdrawal'
  readonly subjectCustomerId: string
  /** The instant the subject asked, from an injected clock. Never defaulted. */
  readonly receivedAtIso: string
  readonly slaDays: number
  /** Derived by `dueDateFor` in `packages/core` and passed in, so one function owns the arithmetic. */
  readonly dueAtIso: string
  readonly verifiedVia: 'otp' | 'in_person_id' | 'staff_attested'
  readonly actorKind: 'customer' | 'staff' | 'system'
  readonly actorLabel: string
  readonly requestDetail: string
}

export interface RightsRequestRow {
  readonly id: string
  readonly requestType: string
  readonly subjectCustomerId: string
  readonly receivedAt: Date
  readonly dueAt: Date
  readonly slaDays: number
  readonly state: string
  readonly closedAt: Date | null
}

const REQUEST_COLUMNS = `
  id, request_type as "requestType", subject_customer_id as "subjectCustomerId",
  received_at as "receivedAt", due_at as "dueAt", sla_days as "slaDays", state, closed_at as "closedAt"
`

export async function recordRightsRequest(
  uow: UnitOfWork,
  input: RightsRequestInput,
): Promise<RightsRequestRow> {
  const [row] = await uow.sql<RightsRequestRow[]>`
    insert into rights_request
      (request_type, subject_customer_id, received_at, sla_days, due_at, verified_via,
       actor_kind, actor_label, request_detail)
    values (${input.requestType}, ${input.subjectCustomerId}::uuid, ${input.receivedAtIso}::timestamptz,
            ${input.slaDays}, ${input.dueAtIso}::timestamptz, ${input.verifiedVia},
            ${input.actorKind}, ${input.actorLabel}, ${input.requestDetail})
    returning ${uow.sql.unsafe(REQUEST_COLUMNS)}
  `
  if (row === undefined) {
    refuse('rights_request_not_actionable', 'The rights request insert returned no row.')
  }
  await uow.audit.record({
    action: 'privacy.rights_request_received',
    entityType: 'rights_request',
    entityId: row.id,
    operation: 'create',
    after: { requestType: input.requestType, dueAt: input.dueAtIso, slaDays: input.slaDays },
  })
  return row
}

/**
 * Every open request the clock has PASSED the due instant of.
 *
 * `due_at < $now` and not `<=`, matching `isOverdue` in `packages/core`: a request is overdue once the
 * clock has gone past its deadline rather than on reaching it, and a frozen-clock test lands on that
 * boundary exactly. The two spellings agreeing is asserted rather than assumed.
 */
export async function overdueRightsRequests(
  sql: Sql,
  nowIso: string,
): Promise<readonly RightsRequestRow[]> {
  return sql<RightsRequestRow[]>`
    select ${sql.unsafe(REQUEST_COLUMNS)}
      from rights_request
     where closed_at is null and due_at < ${nowIso}::timestamptz
     order by due_at asc, id asc
  `
}

/** Moves a request from `received` to `in_progress`. The database refuses any other transition (ZY003). */
export async function beginRightsRequest(uow: UnitOfWork, requestId: string): Promise<void> {
  const rows = await uow.sql`
    update rights_request set state = 'in_progress'
     where id = ${requestId}::uuid and state = 'received'
    returning id
  `
  if (rows.length === 0) {
    refuse(
      'rights_request_not_actionable',
      `Request ${requestId} is not in the "received" state, so it cannot be started. A request is ` +
        'started once; re-running the work is a new request with its own deadline.',
      { requestId },
    )
  }
}

// ------------------------------------------------------------------------------------------------
// Export
// ------------------------------------------------------------------------------------------------

export interface ExportInput {
  readonly rightsRequestId: string | null
  readonly purpose: string
  readonly exportedAtIso: string
  readonly subjectCustomerIds: readonly string[]
  readonly actorKind: 'customer' | 'staff' | 'system'
  readonly actorLabel: string
}

export interface ExportResult {
  readonly exportId: string
  readonly rowCount: number
  readonly subjectCount: number
  readonly alerted: boolean
  readonly rows: readonly Readonly<Record<string, unknown>>[]
}

/**
 * Exports one or more subjects' data, and alerts in the SAME transaction when it is more than one.
 *
 * docs/06 D4's insider-threat control. The alert is a transactional outbox event (0007), so the export
 * record and the notification commit or roll back together — an export that happened with no alert, or an
 * alert for an export that rolled back, are both worse than either half alone. `rights_export.alerted` is
 * tied to `subject_count` by a CHECK, so a bulk export cannot be RECORDED as un-alerted even by a caller
 * that forgot to publish.
 */
export async function exportSubjectData(
  uow: UnitOfWork,
  input: ExportInput,
): Promise<ExportResult> {
  if (input.purpose.trim().length === 0) {
    refuse(
      'rights_export_purpose_absent',
      'An export must state its purpose. An export log whose entries do not say why they happened ' +
        'cannot answer the only question it exists for.',
    )
  }
  const subjectIds = [...new Set(input.subjectCustomerIds)]
  const subjectCount = subjectIds.length
  const alerted = subjectCount > 1

  const rows = await uow.sql<Record<string, unknown>[]>`
    select c.id                as "customerId",
           c.phone_e164        as "phone",
           c.display_name      as "displayName",
           c.locale,
           c.created_via       as "createdVia",
           c.notes,
           c.erased_at         as "erasedAt",
           (select count(*) from booking b where b.customer_id = c.id)  as "bookingCount",
           (select count(*) from invoice i where i.customer_id = c.id)  as "invoiceCount",
           (select count(*) from consent k where k.contact_customer_id = c.id) as "consentCount"
      from customer c
     where c.id = any (${subjectIds}::uuid[])
     order by c.id
  `

  const [record] = await uow.sql<{ id: string }[]>`
    insert into rights_export
      (rights_request_id, purpose, exported_at, row_count, subject_count, alerted,
       actor_kind, actor_label)
    values (${input.rightsRequestId}::uuid, ${input.purpose}, ${input.exportedAtIso}::timestamptz,
            ${rows.length}, ${subjectCount}, ${alerted}, ${input.actorKind}, ${input.actorLabel})
    returning id
  `
  if (record === undefined)
    refuse('rights_export_purpose_absent', 'The export insert returned no row.')

  // Always, not only for a bulk export: `recordExport` is the indexed insider-threat signal (0005) and a
  // single-subject export is still a read of somebody's whole record.
  await uow.audit.recordExport('customer', rows.length, 'privacy.subject_data_exported')

  if (alerted) {
    await uow.publish({
      eventType: 'privacy.bulk_export_alerted',
      aggregateType: 'rights_export',
      aggregateId: record.id,
      payload: { subjectCount, rowCount: rows.length, actorLabel: input.actorLabel },
      // Derived from the export record, so a retry of the same operation cannot enqueue twice.
      idempotencyKey: `privacy.bulk_export_alerted:${record.id}`,
    })
  }

  return { exportId: record.id, rowCount: rows.length, subjectCount, alerted, rows }
}

// ------------------------------------------------------------------------------------------------
// Erasure
// ------------------------------------------------------------------------------------------------

export interface ErasureRuleView {
  readonly key: string
  readonly dataClass: string
  readonly action: string
  /** The MAINTAINER's reason: migrations, SQLSTATEs, the defect the rule is built against. */
  readonly why: string
  /**
   * The DATA SUBJECT's reason, which is what goes in `rights_resolution_class.retained_reason`.
   *
   * Never `why`. `is_placeholder_text` (0026) refuses any text containing `pending`, `unknown`,
   * `placeholder` and six other markers, and the maintainer's prose legitimately contains several of them —
   * writing it into that column rolled the whole erasure back with a constraint name that pointed at
   * nothing. The constraint was right: a sentence handed to somebody exercising a statutory right should
   * not be a code comment. `@berelax/core` requires one on every retaining rule and refuses one carrying a
   * marker, at module load.
   */
  readonly subjectReason?: string
  readonly obligationColumn?: string
  readonly parent?: string
}

export interface ErasureCoverageView {
  readonly classified: readonly (ProbedColumnRow & { readonly rule: ErasureRuleView })[]
  readonly unclassified: readonly ProbedColumnRow[]
  readonly staleRuleKeys: readonly string[]
}

export interface ClinicalDecisionView {
  readonly action: 'crypto_erase' | 'retain_statutory'
  readonly reason: string
  readonly conflict: {
    readonly obligation: string
    readonly years: number
    readonly openQuestionId: string
  } | null
}

export interface ErasureDeps {
  readonly classify: (probed: readonly ProbedColumnRow[]) => ErasureCoverageView
  readonly pseudonymFor: (customerId: string) => string
  readonly planClinical: (input: {
    readonly dataOrigin: 'synthetic' | 'real'
    readonly erasureOverridesRetention: boolean
    readonly clinicalRetentionYears: number
  }) => ClinicalDecisionView
  readonly decideResponse: (input: { readonly supervisoryAuthority: string | null }) => {
    readonly issued: boolean
    readonly refusal?: string
  }
  readonly keying: SuppressionKeying
}

export interface ErasureInput {
  readonly rightsRequestId: string
  readonly erasedAtIso: string
  readonly supervisoryAuthority: string | null
  readonly backupPosition: string
  readonly privacyRegime: string
  readonly regimeIsProvisional: boolean
  readonly openQuestionIds: readonly string[]
}

export interface ErasureReport {
  readonly resolutionId: string
  /** Every `customer` row erased: the one the request named, plus every record merged into it. */
  readonly erasedCustomerIds: readonly string[]
  readonly pseudonyms: readonly string[]
  readonly classes: readonly {
    readonly participant: string
    readonly columnName: string
    readonly action: string
    readonly rowsBefore: number
    readonly rowsActed: number
    readonly rowsRetained: number
  }[]
  readonly clinical: ClinicalDecisionView | null
  readonly responseIssued: boolean
  readonly state: 'completed' | 'partially_completed'
}

interface ProfileRow {
  readonly version: number
  readonly erasureOverridesRetention: boolean
  readonly clinicalRetentionYears: number
  readonly financialRetentionYears: number
}

/**
 * Erases one data subject, and every record merged into them.
 *
 * The whole thing runs inside the caller's unit of work, so the identity, the suppression, the clinical key
 * destruction and the resolution that accounts for all of it commit or roll back together. That is not a
 * nicety: a suppression written without the pseudonymisation would silence a live customer, and a
 * pseudonymisation written without the suppression would leave a re-imported number messageable — the two
 * halves are only safe as a pair.
 */
/**
 * One column's line in the resolution's accounting, carrying the rule that produced it.
 *
 * The rule is carried rather than looked up again by table, and that was a real defect rather than a
 * tidying: `public.invoice` has SIX probed columns under three different rules — `customer_id` and
 * `customer_phone` are `retain_statutory`, `issuer_phone` is `not_customer_data` — so a lookup keyed on the
 * table returned whichever rule the map happened to hold last, and every line for that table was written
 * with that one's data class, reason and obligation. The resolution would then have said the issuer's own
 * telephone number was retained under the FTA obligation, or worse, that the CUSTOMER's was not customer
 * data. The integration test caught it by asserting on a line it could name.
 */
interface ClassLine {
  participant: string
  columnName: string
  action: string
  rowsBefore: number
  rowsActed: number
  rowsRetained: number
  /** The rule this line carried out. Never re-derived from the participant. */
  rule: ErasureRuleView
}

/** Fails closed on a missing decider. Split out so the refusal is one statement rather than a branch. */
function assertDecided(deps: ErasureDeps): void {
  for (const [name, value] of Object.entries({
    classify: deps.classify,
    pseudonymFor: deps.pseudonymFor,
    planClinical: deps.planClinical,
    decideResponse: deps.decideResponse,
  })) {
    if (typeof value !== 'function') {
      refuse(
        'erasure_not_decided',
        `No ${name} was injected, so nothing decided what this erasure should do. There is no fallback ` +
          'on purpose: an erasure that ran with a missing decider would do part of the work and report ' +
          'success, which is the one outcome this engine must never produce.',
        { missing: name },
      )
    }
  }
}

/** Locks the authorising request and reads the profile that will decide every retention. */
async function loadAuthority(
  uow: UnitOfWork,
  rightsRequestId: string,
): Promise<{ readonly subjectCustomerId: string; readonly profile: ProfileRow }> {
  const [request] = await uow.sql<{ subjectCustomerId: string; state: string }[]>`
    select subject_customer_id as "subjectCustomerId", state
      from rights_request
     where id = ${rightsRequestId}::uuid and request_type = 'erasure'
       for update
  `
  if (request === undefined || request.state !== 'in_progress') {
    refuse(
      'rights_request_not_actionable',
      `Request ${rightsRequestId} is not an erasure in progress. The clinical functions refuse without ` +
        'one too (ZY006), so this check is the readable half of a guard the database also keeps.',
      { requestId: rightsRequestId, state: request?.state ?? null },
    )
  }
  const [profile] = await uow.sql<ProfileRow[]>`
    select version,
           erasure_overrides_retention as "erasureOverridesRetention",
           clinical_retention_years    as "clinicalRetentionYears",
           financial_retention_years   as "financialRetentionYears"
      from regulatory_profile_current
  `
  if (profile === undefined) {
    refuse(
      'rights_profile_absent',
      'No regulatory profile is in force, so nothing can say which retention obligations apply or ' +
        'whether erasure overrides them. The resolution would have to state a basis it does not have.',
    )
  }
  return { subjectCustomerId: request.subjectCustomerId, profile }
}

/**
 * Runs the five probes and refuses if anything the catalogue holds is unclassified.
 *
 * Before a single row is touched, which is the point: a partial erasure is worse than a refused one,
 * because a refused one is visible.
 */
async function loadCoverageOrRefuse(
  uow: UnitOfWork,
  deps: ErasureDeps,
): Promise<ErasureCoverageView> {
  const coverage = deps.classify(await erasureCoverage(uow.sql))
  if (coverage.unclassified.length > 0) {
    refuse(
      'erasure_coverage_incomplete',
      'The catalogue holds columns no erasure rule classifies, so this erasure cannot say what it did ' +
        'to them and will not run:\n' +
        coverage.unclassified
          .map((c) => `  - ${c.schema}.${c.table}.${c.column} (found by ${c.axes.join(', ')})`)
          .join('\n') +
        '\nClassify each one in packages/core/src/privacy/rights-policy.ts. A completed erasure that ' +
        'left a contact detail in an unenumerated table is how this business comes to message somebody ' +
        'who asked to be forgotten.',
      { unclassified: coverage.unclassified.map((c) => `${c.schema}.${c.table}.${c.column}`) },
    )
  }
  assertRecipesMatchRules(coverage.classified.map((c) => c.rule))
  return coverage
}

/**
 * Every `customer` row that IS this person: the one the request named, plus every record merged into it.
 *
 * Recursive, because a survivor can itself have been merged into. A merge leaves a tombstone rather than
 * deleting (0069), so each of those rows still holds its own live phone number — and erasing only the id
 * the request named would leave the person reachable through a row the request never mentioned.
 */
async function loadIdentities(
  uow: UnitOfWork,
  subjectCustomerId: string,
): Promise<{ readonly customerIds: readonly string[]; readonly livePhones: readonly string[] }> {
  const identities = await uow.sql<{ id: string; phone: string; erasedAt: Date | null }[]>`
    with recursive lineage(id) as (
      select ${subjectCustomerId}::uuid
      union
      select m.loser_customer_id from merge_record m join lineage l on m.survivor_customer_id = l.id
    )
    select c.id, c.phone_e164 as phone, c.erased_at as "erasedAt"
      from customer c join lineage l on l.id = c.id
     order by c.id
  `
  return {
    customerIds: identities.map((i) => i.id),
    livePhones: identities.filter((i) => i.erasedAt === null).map((i) => i.phone),
  }
}

/**
 * Which column on this table identifies the subject, derived from the CATALOGUE rather than from a list.
 *
 * Needed because the column a rule is keyed on is often not the column the subject is matched by:
 * `invoice.customer_phone` is retained, and the rows are found through `invoice.customer_id`. An earlier
 * draft matched on the keyed column itself, which made `rowsBefore` zero for every retained snapshot — so
 * the most important retention in the unit would have reported nothing retained and carried no reason, and
 * the accounting constraint would have been satisfied by a line that said nothing. Worse, on a redaction it
 * made `rowsRetained` negative and the database refused the whole erasure with an arithmetic error that
 * named nothing.
 *
 * The preference order is deliberate: a customer reference first because it is exact, then the phone
 * columns for the three tables that have no reference at all.
 */
function subjectColumnFor(
  table: string,
  coverage: ErasureCoverageView,
): { readonly column: string; readonly kind: 'customer_id' | 'phone' } | null {
  const columns = coverage.classified.filter((c) => `${c.schema}.${c.table}` === table)
  const reference = columns.find((c) => /^(.*_)?(customer|contact)_id$/.test(c.column))
  if (reference !== undefined) return { column: reference.column, kind: 'customer_id' }
  const phone = columns.find((c) => c.column === 'phone_e164' || c.column === 'recipient')
  if (phone !== undefined) return { column: phone.column, kind: 'phone' }
  // `public.customer` itself: its primary key is `id`, so it has no reference column of its own.
  if (table === 'public.customer') return { column: 'id', kind: 'customer_id' }
  return null
}

/**
 * Carries out every public-schema rule, identity last, and returns the accounting.
 *
 * Identity last because that is the order a person would do the work in, and NOT because correctness
 * depends on it: the phone numbers arrive in `ctx.livePhones`, which {@link loadIdentities} captured from
 * the LIVE records before any statement ran. That capture is the safeguard; the ordering is presentation.
 *
 * An earlier draft of this comment claimed the ordering was load-bearing — that pseudonymising first would
 * leave every message unredacted and write no suppression — and gate case 112j disproved it by reversing
 * the order and changing nothing. The case now breaks the capture instead, which is the thing that would
 * actually break. A comment defending a safeguard that is not there is worse than no comment: it tells the
 * next person the problem is solved somewhere it is not.
 *
 * What `rowsBefore` MEANS differs between the two kinds of rule, and it has to. For an acting rule it is
 * the rows that still hold something to act on, so `rowsActed` equals it and `rowsRetained` is zero — a
 * `display_name` that was already null is not a row left behind. For a retaining rule it is every row of
 * the subject's, all of which are retained and all of which therefore need the reason. Either way
 * `rows_before = rows_acted + rows_retained` holds, and a retained row with nothing saying why is refused.
 */
async function actOnPublicSchema(
  uow: UnitOfWork,
  deps: ErasureDeps,
  coverage: ErasureCoverageView,
  ctx: {
    readonly customerIds: readonly string[]
    readonly livePhones: readonly string[]
    readonly erasedAtIso: string
    readonly rightsRequestId: string
  },
): Promise<readonly ClassLine[]> {
  const classes: ClassLine[] = []
  const byKey = new Map(EXECUTION_RECIPES.map((r) => [r.ruleKey, r]))
  const rank = (key: string) => (key === 'public.customer.phone_e164' ? 1 : 0)
  const ordered = [...coverage.classified].sort((a, b) => rank(a.rule.key) - rank(b.rule.key))

  for (const entry of ordered) {
    // The clinical schema is unreachable from the application role (0009) and goes through the SECURITY
    // DEFINER functions instead, counted once per table by `actOnClinicalSchema`.
    if (entry.schema === 'clinical') continue
    const participant = `${entry.schema}.${entry.table}`

    if (!ACTING_ACTIONS.includes(entry.rule.action)) {
      // Only a RETAINING action counts rows. See `RETAINING_ERASURE_ACTIONS`: a line for
      // `inherits_parent` or `not_customer_data` reports zeros, because it records that the column was
      // classified rather than that anybody's data stayed in it.
      const counts = RETAINING_ERASURE_ACTIONS.includes(entry.rule.action)
        ? await (async () => {
            const subject = subjectColumnFor(participant, coverage)
            return subject === null
              ? 0
              : await countRows(uow.sql, participant, subject, ctx.customerIds, ctx.livePhones)
          })()
        : 0
      classes.push({
        participant,
        columnName: entry.column,
        action: entry.rule.action,
        rowsBefore: counts,
        rowsActed: 0,
        rowsRetained: counts,
        rule: entry.rule,
      })
      continue
    }
    const r = byKey.get(entry.rule.key)
    if (r === undefined) {
      refuse('erasure_recipe_mismatch', `No statement carries out ${entry.rule.key}.`, {
        ruleKey: entry.rule.key,
      })
    }
    const acted = await applyRecipe(uow.sql, r, {
      customerIds: ctx.customerIds,
      phones: ctx.livePhones,
      pseudonymFor: deps.pseudonymFor,
      erasedAtIso: ctx.erasedAtIso,
      rightsRequestId: ctx.rightsRequestId,
    })
    classes.push({
      participant,
      columnName: entry.column,
      action: entry.rule.action,
      rowsBefore: acted,
      rowsActed: acted,
      rowsRetained: 0,
      rule: entry.rule,
    })
  }
  return classes
}

/**
 * The clinical half: decide, then either destroy the keys or retain and say why.
 *
 * The decision is `planClinicalErasure`'s, not this function's. What is decided HERE is only which origin
 * to decide for, and the rule is the strictest one present: a single `real` payload among synthetic ones
 * makes the conflict live for all of them, because deciding per row would let a synthetic sibling's
 * decision govern a real record.
 *
 * ## Every clinical read and write goes through a SECURITY DEFINER function, and that is not optional
 *
 * 0009 revokes every privilege on the `clinical` schema from the application role, so `berelax_app` cannot
 * `select` from it at all. An earlier draft of this function issued three direct selects — the origin
 * probe on every run, and the two retain-branch counts — and therefore could only ever have run as the
 * database OWNER. Nothing caught it: the integration suite connects as the owner, and the app-role case in
 * `rights.itest.ts` asserted the role "cannot reach the clinical schema at all" while this function did
 * exactly that. `public.clinical_erasure_census` is the read counterpart of `destroy_customer_deks`, and
 * there is now a case that runs a whole erasure as `berelax_app`, which is the only thing that would have
 * found it.
 *
 * ## It loops over the MERGE LINEAGE, not over the subject alone
 *
 * A record merged into the subject is the same person, and its clinical rows still carry the LOSER's
 * customer_id — this schema resolves the tombstone on read rather than being re-pointed (0069). An earlier
 * draft passed only `ctx.subjectCustomerId` to the destruction while reading the origin across the whole
 * lineage, so a merged-away record's health data stayed readable under a key nobody destroyed, and the
 * accounting reported a complete crypto-erasure because it had counted only the survivor's rows. The
 * functions authorise each id through `merge_survivor_of`, so each call is checked on its own.
 *
 * ## It accounts for all FIVE clinical tables, not the three it acts on
 *
 * `clinical.treatment_consent` and `clinical.dek_destruction` are both classified and both RETAINED, and
 * an earlier draft emitted no `rights_resolution_class` line for either — so a completed erasure's
 * accounting silently omitted two of the fifty-two tables the catalogue enumerates, which are two of the
 * things a data subject is most entitled to be told are being kept. `rights.itest.ts` now requires every
 * covered table to appear in the resolution BY NAME.
 */
async function actOnClinicalSchema(
  uow: UnitOfWork,
  deps: ErasureDeps,
  coverage: ErasureCoverageView,
  ctx: {
    readonly subjectCustomerId: string
    readonly customerIds: readonly string[]
    readonly rightsRequestId: string
    readonly erasedAtIso: string
    readonly profile: ProfileRow
  },
): Promise<{ readonly decision: ClinicalDecisionView; readonly classes: readonly ClassLine[] }> {
  /** The rule for one clinical table's `customer_id`, from the coverage. Never invented here. */
  const ruleFor = (table: string): ErasureRuleView => {
    const found = coverage.classified.find(
      (c) => `${c.schema}.${c.table}` === table && c.column === 'customer_id',
    )
    if (found === undefined) {
      refuse('erasure_coverage_incomplete', `${table}.customer_id is not classified.`, { table })
    }
    return found.rule
  }
  const ids = [...ctx.customerIds]

  // The census, once per id in the merge lineage. Through a SECURITY DEFINER function because the
  // application role holds no privilege on the clinical schema at all — see this function's header.
  let hasRealPayload = false
  let consentRows = 0
  for (const id of ids) {
    const [row] = await uow.sql<
      {
        hasRealPayload: boolean
        intakeRows: number
        noteRows: number
        consentRows: number
        destructionRows: number
      }[]
    >`
      select has_real_payload as "hasRealPayload", intake_rows as "intakeRows",
             note_rows as "noteRows", consent_rows as "consentRows",
             destruction_rows as "destructionRows"
        from public.clinical_erasure_census(${id}::uuid, ${ctx.rightsRequestId}::uuid)
    `
    if (row === undefined) continue
    if (row.hasRealPayload) hasRealPayload = true
    consentRows += Number(row.consentRows)
  }

  const decision = deps.planClinical({
    dataOrigin: hasRealPayload ? 'real' : 'synthetic',
    erasureOverridesRetention: ctx.profile.erasureOverridesRetention,
    clinicalRetentionYears: ctx.profile.clinicalRetentionYears,
  })

  /**
   * The consent record, which is RETAINED under either decision and is why it is built once here.
   *
   * It holds no health content — a wording hash, a locale, how it was captured — and it is the only
   * evidence that the destroyed submissions were lawfully taken, so destroying it would be the worst of
   * both. Its reason is its own rule's and NOT the clinical decision's: the decision is about the payload,
   * and a sentence about retaining health data would be untrue of a table that holds none.
   */
  const consentLine = (): ClassLine => ({
    participant: 'clinical.treatment_consent',
    columnName: 'customer_id',
    action: 'retain_statutory',
    rowsBefore: consentRows,
    rowsActed: 0,
    rowsRetained: consentRows,
    rule: ruleFor('clinical.treatment_consent'),
  })

  if (decision.action !== 'crypto_erase') {
    // The retain branch. Counted from the census rather than from a direct select, for the privilege
    // reason above, and summed across the lineage rather than read for the survivor alone.
    let intakeRows = 0
    let noteRows = 0
    let destructionRows = 0
    for (const id of ids) {
      const [row] = await uow.sql<
        { intakeRows: number; noteRows: number; destructionRows: number }[]
      >`
        select intake_rows as "intakeRows", note_rows as "noteRows",
               destruction_rows as "destructionRows"
          from public.clinical_erasure_census(${id}::uuid, ${ctx.rightsRequestId}::uuid)
      `
      intakeRows += Number(row?.intakeRows ?? 0)
      noteRows += Number(row?.noteRows ?? 0)
      destructionRows += Number(row?.destructionRows ?? 0)
    }
    const retained: ClassLine[] = [
      ['clinical.intake_submission', intakeRows] as const,
      ['clinical.treatment_note', noteRows] as const,
    ].map(([participant, n]) => ({
      participant,
      columnName: 'customer_id',
      action: 'retain_statutory',
      rowsBefore: n,
      rowsActed: 0,
      rowsRetained: n,
      rule: ruleFor(participant),
    }))
    retained.push(consentLine())
    // Accounted for even here, where it is almost always empty: a subject erased once under a profile that
    // destroyed the keys and again under one that retains them has destruction rows from the first pass,
    // and a table left out of the report is a table nobody can ask about.
    retained.push(destructionLine(destructionRows, ruleFor('clinical.dek_destruction')))
    return { decision, classes: retained }
  }

  // The destroying branch, once per id in the lineage. A record merged into the subject is the same person
  // and its rows still carry the loser's customer_id; the function authorises each id through
  // `merge_survivor_of`, so every call is checked rather than trusted.
  const destroyedByTable = new Map<string, number>()
  let flagsDeleted = 0
  for (const id of ids) {
    const destroyed = await uow.sql<
      { targetTable: string; rowsDestroyed: number; rowsAlreadyDestroyed: number }[]
    >`
      select target_table as "targetTable", rows_destroyed as "rowsDestroyed",
             rows_already_destroyed as "rowsAlreadyDestroyed"
        from public.destroy_customer_deks(${id}::uuid,
                                           ${ctx.rightsRequestId}::uuid,
                                           ${ctx.erasedAtIso}::timestamptz)
    `
    for (const row of destroyed) {
      // A key already destroyed by an earlier run counts as ACTED ON rather than retained: it is
      // destroyed, and reporting it as retained would demand a retained_reason for data that is not there.
      const before = Number(row.rowsDestroyed) + Number(row.rowsAlreadyDestroyed)
      destroyedByTable.set(row.targetTable, (destroyedByTable.get(row.targetTable) ?? 0) + before)
    }
    const [flags] = await uow.sql<{ deleted: number }[]>`
      select public.delete_customer_contraindications(${id}::uuid,
                                                        ${ctx.rightsRequestId}::uuid) as deleted
    `
    flagsDeleted += Number(flags?.deleted ?? 0)
  }

  // Both sealed tables are reported whether or not the subject had a row in either, because the report is
  // the account of what the erasure DID about each table and "nothing to do" is an answer. Keyed off the
  // rule registry rather than off what the loop happened to return, so a table the function stopped
  // mentioning could not silently leave the accounting.
  const lines: ClassLine[] = ['intake_submission', 'treatment_note'].map((table) => {
    const before = destroyedByTable.get(table) ?? 0
    return {
      participant: `clinical.${table}`,
      columnName: 'customer_id',
      action: 'crypto_erase',
      rowsBefore: before,
      rowsActed: before,
      rowsRetained: 0,
      rule: ruleFor(`clinical.${table}`),
    }
  })
  lines.push({
    participant: 'clinical.contraindication_flag',
    columnName: 'customer_id',
    action: 'delete_row',
    rowsBefore: flagsDeleted,
    rowsActed: flagsDeleted,
    rowsRetained: 0,
    rule: ruleFor('clinical.contraindication_flag'),
  })
  lines.push(consentLine())
  // The destruction log, counted AFTER the destruction so the number is the rows this erasure's own work
  // left behind plus any earlier pass's. It is the one retention in this unit that is a CONSEQUENCE of the
  // erasure rather than something surviving it, which is why it carries its own reason and not the
  // decision's.
  let destructionRows = 0
  for (const id of ids) {
    const [row] = await uow.sql<{ destructionRows: number }[]>`
      select destruction_rows as "destructionRows"
        from public.clinical_erasure_census(${id}::uuid, ${ctx.rightsRequestId}::uuid)
    `
    destructionRows += Number(row?.destructionRows ?? 0)
  }
  lines.push(destructionLine(destructionRows, ruleFor('clinical.dek_destruction')))
  return { decision, classes: lines }
}

/** The `clinical.dek_destruction` accounting line. Retained because the table is append-only (ZY005). */
function destructionLine(rows: number, rule: ErasureRuleView): ClassLine {
  return {
    participant: 'clinical.dek_destruction',
    columnName: 'customer_id',
    action: 'retain_append_only',
    rowsBefore: rows,
    rowsActed: 0,
    rowsRetained: rows,
    rule,
  }
}

/**
 * The three derived columns of one `rights_resolution_class` row: the obligation, its figure and the reason.
 *
 * Extracted from {@link writeResolution} rather than inlined, and not only because Biome's complexity rule
 * refused the combined function: these three values are the whole of what the accounting ASSERTS about a
 * line, and the insert around them is bookkeeping. Read together they are reviewable; interleaved with an
 * INSERT they were not.
 */
function classValuesFor(
  line: ClassLine,
  ctx: {
    readonly profile: ProfileRow
    readonly clinicalReason: string
  },
): {
  readonly obligationColumn: string | null
  readonly obligationYears: number | null
  readonly retainedReason: string | null
} {
  const rule = line.rule
  // The clinical DECISION's sentence belongs to the two tables the decision is ABOUT, and to nothing else.
  // `participant.startsWith('clinical.')` was the earlier test and it was too wide: it would have put "your
  // health information is kept, because health records must be retained for 25 years" onto
  // `clinical.treatment_consent`, which holds a wording hash and no health information at all, and onto
  // `clinical.dek_destruction`, whose retention is the RECORD OF THE DESTRUCTION and is very nearly the
  // opposite claim. Each has its own subject reason in the rule registry, and both are better sentences.
  const isDecidedPayload =
    line.participant === 'clinical.intake_submission' ||
    line.participant === 'clinical.treatment_note'
  // Keyed on the SCHEMA and not on the decided pair: `clinical.treatment_consent` is a statutory retention
  // under the clinical figure too, and it is not a payload the decision covers.
  const isClinical = line.participant.startsWith('clinical.')
  const obligationColumn =
    line.action === 'retain_statutory'
      ? isClinical
        ? 'clinical_retention_years'
        : (rule.obligationColumn ?? 'financial_retention_years')
      : null
  const obligationYears =
    obligationColumn === 'clinical_retention_years'
      ? ctx.profile.clinicalRetentionYears
      : obligationColumn === 'financial_retention_years'
        ? ctx.profile.financialRetentionYears
        : null
  // The SUBJECT's reason, never the maintainer's — see `ErasureRuleView.subjectReason`. For the two tables
  // the clinical decision is ABOUT it is the decision's own sentence, because that names the profile setting
  // that decided it and a fixed sentence could not: a reason that stayed true after the profile changed
  // would not be the reason. Every other line, clinical or not, carries its own rule's.
  //
  // No fallback to `why`. A retaining rule without a subject reason is refused by `@berelax/core` at module
  // load, so reaching here without one is a bug — and papering over it with the maintainer's prose is
  // exactly what `is_placeholder_text` refused, rolling a whole erasure back.
  if (line.rowsRetained > 0 && !isDecidedPayload && (rule.subjectReason ?? '') === '') {
    refuse(
      'erasure_coverage_incomplete',
      `${rule.key} retained ${line.rowsRetained} row(s) with no subject-facing reason. The reason is ` +
        'what a data subject is entitled to be given, and the maintainer\u2019s prose is not it.',
      { ruleKey: rule.key },
    )
  }
  const retainedReason =
    line.rowsRetained > 0
      ? (isDecidedPayload ? ctx.clinicalReason : (rule.subjectReason ?? '')).slice(0, 1000)
      : null
  return { obligationColumn, obligationYears, retainedReason }
}

/** Writes the resolution and its per-class accounting. The database refuses an incoherent line. */
async function writeResolution(
  uow: UnitOfWork,
  input: ErasureInput,
  ctx: {
    readonly profile: ProfileRow
    readonly pseudonym: string | null
    readonly responseIssued: boolean
    readonly responseRefusal: string | null
    readonly classes: readonly ClassLine[]
    readonly clinicalReason: string
  },
): Promise<string> {
  const [resolution] = await uow.sql<{ id: string }[]>`
    insert into rights_resolution
      (rights_request_id, resolved_at, regulatory_profile_version, pseudonym, privacy_regime,
       regime_is_provisional, open_question_ids, backup_position, response_issued,
       response_withheld_reason)
    values (${input.rightsRequestId}::uuid, ${input.erasedAtIso}::timestamptz, ${ctx.profile.version},
            ${ctx.pseudonym}, ${input.privacyRegime}, ${input.regimeIsProvisional},
            ${[...input.openQuestionIds]}::text[], ${input.backupPosition}, ${ctx.responseIssued},
            ${ctx.responseRefusal})
    returning id
  `
  if (resolution === undefined) {
    refuse('rights_profile_absent', 'The resolution insert returned no row.')
  }

  for (const line of ctx.classes) {
    const rule = line.rule
    const { obligationColumn, obligationYears, retainedReason } = classValuesFor(line, ctx)
    await uow.sql`
      insert into rights_resolution_class
        (rights_resolution_id, data_class, participant, column_name, action, rows_before, rows_acted,
         rows_retained, retained_reason, obligation_column, obligation_years)
      values (${resolution.id}::uuid, ${rule.dataClass}, ${line.participant},
              ${line.columnName}, ${line.action}, ${line.rowsBefore}, ${line.rowsActed},
              ${line.rowsRetained}, ${retainedReason}, ${obligationColumn}, ${obligationYears})
      on conflict (rights_resolution_id, participant, column_name) do nothing
    `
  }
  return resolution.id
}

export async function eraseSubject(
  uow: UnitOfWork,
  deps: ErasureDeps,
  input: ErasureInput,
): Promise<ErasureReport> {
  assertDecided(deps)
  const { subjectCustomerId, profile } = await loadAuthority(uow, input.rightsRequestId)
  const coverage = await loadCoverageOrRefuse(uow, deps)
  const { customerIds, livePhones } = await loadIdentities(uow, subjectCustomerId)

  const publicClasses = await actOnPublicSchema(uow, deps, coverage, {
    customerIds,
    livePhones,
    erasedAtIso: input.erasedAtIso,
    rightsRequestId: input.rightsRequestId,
  })

  // The suppression that keeps the person un-messageable, WRITTEN rather than merely preserved: somebody
  // who never opted out has no entry, so a re-import of the same number from a spreadsheet would create a
  // fresh record with a clean sheet. The plaintext exists only as a query parameter on the way in —
  // `suppression` stores an HMAC and never a number. It is written from `livePhones`, which
  // `loadIdentities` captured from the LIVE records before any statement ran; that capture is the whole
  // safeguard, and gate case 112j breaks it by reading the erased records' numbers instead.
  for (const phone of livePhones) {
    await recordSuppression(uow, deps.keying, {
      keyKind: 'phone',
      recipient: phone,
      source: 'erasure_request',
      reason:
        'Recorded by the erasure of this record under a data-subject request. Kept so that re-importing ' +
        'the same number cannot make the person messageable again.',
      actorKind: 'system',
      actorLabel: 'privacy.erasure-engine',
      recordedAtIso: input.erasedAtIso,
      contactCustomerId: null,
    })
  }

  const clinical = await actOnClinicalSchema(uow, deps, coverage, {
    subjectCustomerId,
    customerIds,
    rightsRequestId: input.rightsRequestId,
    erasedAtIso: input.erasedAtIso,
    profile,
  })

  const classes = [...publicClasses, ...clinical.classes]
  const response = deps.decideResponse({ supervisoryAuthority: input.supervisoryAuthority })
  const pseudonyms = customerIds.map((id) => deps.pseudonymFor(id))

  const resolutionId = await writeResolution(uow, input, {
    profile,
    pseudonym: pseudonyms[0] ?? null,
    responseIssued: response.issued,
    responseRefusal: response.issued
      ? null
      : (response.refusal ?? 'rights_response_authority_absent'),
    classes,
    clinicalReason: clinical.decision.reason,
  })

  // `partially_completed` and not `completed` whenever anything was retained, and that is deliberate
  // rather than pedantic: every erasure of a customer who has ever been invoiced retains something, so
  // this is the NORMAL outcome and `completed` is the rare one. A request reported as fully completed
  // while a tax document still names the person would be the engine telling the subject something untrue.
  const state: 'completed' | 'partially_completed' = classes.some((c) => c.rowsRetained > 0)
    ? 'partially_completed'
    : 'completed'
  await uow.sql`
    update rights_request set state = ${state}, closed_at = ${input.erasedAtIso}::timestamptz
     where id = ${input.rightsRequestId}::uuid
  `
  await uow.audit.record({
    action: 'privacy.subject_erased',
    entityType: 'rights_request',
    entityId: input.rightsRequestId,
    operation: 'update',
    after: {
      resolutionId,
      erasedCustomerIds: customerIds,
      state,
      responseIssued: response.issued,
      clinicalAction: clinical.decision.action,
    },
  })

  return {
    resolutionId,
    erasedCustomerIds: customerIds,
    pseudonyms,
    classes: classes.map(({ rule: _rule, ...line }) => line),
    clinical: clinical.decision,
    responseIssued: response.issued,
    state,
  }
}

// ------------------------------------------------------------------------------------------------
// The statements
// ------------------------------------------------------------------------------------------------

/**
 * How many rows of this participant belong to the subject.
 *
 * The identifiers are interpolated because a dynamic table name cannot be bound; `recipeRegistry` and
 * {@link SQL_IDENTIFIER} — the SAME constant the merge executor checks its participants with, imported
 * rather than restated — are what make that safe, and the ids and the phone numbers are always parameters.
 */
async function countRows(
  sql: Sql,
  target: string,
  subject: { readonly column: string; readonly kind: 'customer_id' | 'phone' },
  customerIds: readonly string[],
  phones: readonly string[],
): Promise<number> {
  const [schema, table] = target.split('.')
  if (
    schema === undefined ||
    table === undefined ||
    !SQL_IDENTIFIER.test(schema) ||
    !SQL_IDENTIFIER.test(table) ||
    !SQL_IDENTIFIER.test(subject.column)
  ) {
    refuse(
      'erasure_recipe_mismatch',
      `${target}.${subject.column} is not a bare SQL identifier path.`,
    )
  }
  const values = subject.kind === 'phone' ? [...phones] : [...customerIds]
  const cast = subject.kind === 'phone' ? 'text[]' : 'uuid[]'
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from ${sql.unsafe(target)}
     where ${sql.unsafe(subject.column)} = any (${values}::${sql.unsafe(cast)})
  `
  return Number(row?.n ?? 0)
}

async function applyRecipe(
  sql: Sql,
  r: ExecutionRecipe,
  ctx: {
    readonly customerIds: readonly string[]
    readonly phones: readonly string[]
    readonly pseudonymFor: (id: string) => string
    readonly erasedAtIso: string
    /** Needed by the `definer` route: the function refuses without a request that authorises it. */
    readonly rightsRequestId: string
  },
): Promise<number> {
  const target = `${r.schema}.${r.table}`
  if (r.action === 'pseudonymise') {
    // One statement per record, because the pseudonym is a function of the row's own id and
    // `customer_erasure_and_pseudonym_agree` requires both columns to move together.
    let acted = 0
    for (const id of ctx.customerIds) {
      const rows = await sql`
        update customer
           set phone_e164 = ${ctx.pseudonymFor(id)}, erased_at = ${ctx.erasedAtIso}::timestamptz
         where id = ${id}::uuid and erased_at is null
        returning id
      `
      acted += rows.length
    }
    return acted
  }

  const where =
    r.subjectKey === 'phone'
      ? sql`${sql.unsafe(r.matchColumn)} = any (${[...ctx.phones]}::text[])`
      : r.subjectKey === 'booking_of_customer'
        ? sql`${sql.unsafe(r.matchColumn)} in (
              select id from booking where customer_id = any (${[...ctx.customerIds]}::uuid[]))`
        : sql`${sql.unsafe(r.matchColumn)} = any (${[...ctx.customerIds]}::uuid[])`

  if (r.action === 'delete_row') {
    // The privileged route, for the two tables whose DELETE the application role does not hold. One call
    // per id in the merge lineage, because the function authorises one customer at a time — the same shape
    // `destroy_customer_deks` is called in, and for the same reason.
    if (r.via === 'definer') {
      let acted = 0
      for (const id of ctx.customerIds) {
        const [row] = await sql<{ n: number }[]>`
          select public.erase_customer_workflow_rows(${id}::uuid, ${ctx.rightsRequestId}::uuid,
                                                     ${r.table}) as n
        `
        acted += Number(row?.n ?? 0)
      }
      return acted
    }
    const rows = await sql`delete from ${sql.unsafe(target)} where ${where} returning 1 as one`
    return rows.length
  }

  if (r.action !== 'redact') {
    // Defensive, and it closes a real trap rather than a hypothetical one. The branches above are
    // `pseudonymise` and `delete_row`; everything else used to FALL THROUGH into the redact statement, so a
    // `crypto_erase` recipe arriving here would have issued `set <column> = null` on a clinical table. It
    // cannot arrive today because `actOnPublicSchema` skips the clinical schema before the loop reaches it,
    // and "cannot today" is exactly how a fallthrough becomes reachable in a later refactor that has no
    // reason to read this function.
    refuse(
      'erasure_recipe_mismatch',
      `${r.ruleKey} has action "${r.action}", which no statement in this executor carries out.`,
      { ruleKey: r.ruleKey, action: r.action },
    )
  }
  const replacement = r.redactTo === 'marker' ? REDACTION_MARKER : null
  const rows = await sql`
    update ${sql.unsafe(target)} set ${sql.unsafe(r.column)} = ${replacement}
     where ${where} and ${sql.unsafe(r.column)} is distinct from ${replacement}
    returning 1 as one
  `
  return rows.length
}
