import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The client record's writes (C-CRM-01): preferences, tags, lifecycle, source, VIP, the blocklist and
 * the therapist do-not-pair flag.
 *
 * ## Every rule that decides something is INJECTED
 *
 * `packages/db` must never import `packages/core` — the dependency runs core ← db — and three of the
 * decisions in this file belong to core:
 *
 *   - which lifecycle move a (state, event) pair produces ({@link LifecycleDecider});
 *   - whether a role may change the blocklist ({@link BlocklistAuthoriser});
 *   - whether a set of contact keys matches an entry ({@link BlocklistMatcher}).
 *
 * Each arrives as a function, and a caller that supplies none is **refused by name** rather than
 * defaulted: `lifecycle_not_decided`, `blocklist_not_authorised`, `blocklist_not_evaluated`. That is the
 * same fail-closed seam `createBooking` uses for its slot re-check, and it exists because the permissive
 * version of each of these is the dangerous one — an unauthorised blocklist change, or a blocklist that
 * matched nothing because nothing evaluated it.
 *
 * There is no `if (role === 'manager')` anywhere in this file. A hand-rolled check at a call site is a
 * second copy of the F07 matrix, and the second copy is the one that falls behind.
 *
 * ## Every write here is audited, and the two vocabulary tables are audited by a TRIGGER
 *
 * {@link CRM_AUDIT_COVERAGE} is the register of which mutable table in the CRM area is covered by which,
 * and {@link crmAuditCoverage} enumerates the area from `information_schema` and checks it against the
 * register — so a table added to the area without either fails
 * `packages/fixtures/src/crm-client-record.itest.ts` rather than shipping unaudited.
 */

// ------------------------------------------------------------------------------------------------
// The injected rules
// ------------------------------------------------------------------------------------------------

/** Every reason a CRM write is refused, as a value. Callers branch on these, never on prose. */
export const CRM_REFUSALS = [
  'customer_not_found',
  /** No lifecycle decider was injected, so nothing applied the transition table. Fail closed. */
  'lifecycle_not_decided',
  /** The reducer refused the pair. `detail` carries its own named refusal. */
  'lifecycle_refused',
  /** No authoriser was injected for a blocklist or do-not-pair change. Fail closed. */
  'blocklist_not_authorised',
  /** The authoriser refused this role. `detail` carries its own named refusal. */
  'blocklist_forbidden',
  /** No matcher was injected, so nothing decided the evaluation. Fail closed. */
  'blocklist_not_evaluated',
  /** The entry is not there, or is already lifted. A second lift is an error, not a no-op. */
  'blocklist_entry_not_active',
  'do_not_pair_not_active',
  /** A reason was required and none was given. Blank counts as absent. */
  'reason_required',
] as const
export type CrmRefusal = (typeof CRM_REFUSALS)[number]

/** `decideCustomerLifecycle` from `@berelax/core`, injected. Strings, because the vocabulary is core's. */
export type LifecycleDecider = (
  from: string,
  event: string,
) =>
  | { readonly kind: 'moved'; readonly to: string; readonly why: string }
  | { readonly kind: 'unchanged'; readonly state: string; readonly why: string }
  | { readonly kind: 'refused'; readonly refusal: string; readonly why: string }

/** `mayChangeBlocklist` from `@berelax/core`, injected. Deny-by-default, including an unknown role. */
export type BlocklistAuthoriser = (
  role: string,
) => { readonly allowed: true } | { readonly allowed: false; readonly refusal: string }

/** A normalised contact key. Mirrors `BlocklistKey` in core, which this package may not import. */
export interface ContactKey {
  readonly kind: string
  readonly value: string
}

/** `decideBlocklist` from `@berelax/core`, injected. Mirrors `BlocklistVerdict`. */
export type BlocklistMatcher = (
  keys: readonly ContactKey[],
  entries: readonly {
    readonly id: string
    readonly kind: string
    readonly value: string
    readonly reason: string
  }[],
) =>
  | {
      readonly kind: 'matched'
      readonly matchedKeyKind: string
      readonly entryId: string
      readonly reason: string
    }
  | { readonly kind: 'clear'; readonly keyKindsChecked: readonly string[] }

function refuse(
  refusal: CrmRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AppError(refusal === 'blocklist_forbidden' ? 'forbidden' : 'conflict', message, {
    details: { ...details, refusal },
  })
}

/** The named refusal carried on an error this module raised, or null. */
export function crmRefusalOf(err: unknown): CrmRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' && (CRM_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as CrmRefusal)
    : null
}

const stated = (value: string | null | undefined): string => {
  const text = (value ?? '').trim()
  if (text.length === 0) {
    refuse(
      'reason_required',
      'A written reason is mandatory for this change. A blocklist entry or a do-not-pair flag with no ' +
        'stated reason cannot be reviewed, and 0053 refuses one at the database as well.',
    )
  }
  return text
}

// ------------------------------------------------------------------------------------------------
// Preferences, tags, source and VIP
// ------------------------------------------------------------------------------------------------

export interface CustomerPreferenceInput {
  readonly customerId: string
  readonly preferredLanguage?: 'en' | 'ar' | null
  readonly preferredTherapistGender?: 'female' | 'male' | null
  readonly preferredRoomType?: string | null
  readonly pressureNote?: string | null
  readonly oilNote?: string | null
  readonly musicNote?: string | null
}

export interface CustomerPreferenceRecord {
  readonly customerId: string
  readonly preferredLanguage: 'en' | 'ar' | null
  readonly preferredTherapistGender: 'female' | 'male' | null
  readonly preferredRoomType: string | null
  readonly pressureNote: string | null
  readonly oilNote: string | null
  readonly musicNote: string | null
}

interface PreferenceRow {
  readonly customer_id: string
  readonly preferred_language: 'en' | 'ar' | null
  readonly preferred_therapist_gender: 'female' | 'male' | null
  readonly preferred_room_type: string | null
  readonly pressure_note: string | null
  readonly oil_note: string | null
  readonly music_note: string | null
}

const toPreference = (row: PreferenceRow): CustomerPreferenceRecord => ({
  customerId: row.customer_id,
  preferredLanguage: row.preferred_language,
  preferredTherapistGender: row.preferred_therapist_gender,
  preferredRoomType: row.preferred_room_type,
  pressureNote: row.pressure_note,
  oilNote: row.oil_note,
  musicNote: row.music_note,
})

/**
 * Writes the whole preference row, creating it if there is none.
 *
 * An upsert over the WHOLE row rather than a patch of the fields the caller mentioned, and the reason is
 * the screen: the admin form posts every field, and a patch semantics would make "clear the oil note"
 * impossible to express — an absent field would mean "leave it" and there would be no way to say "there
 * is no preference any more". So an omitted field is `null`, and the audit row records the before and
 * after states so a cleared note is visible as a change rather than as an absence.
 */
export async function setCustomerPreferences(
  uow: UnitOfWork,
  input: CustomerPreferenceInput,
): Promise<CustomerPreferenceRecord> {
  const before = await readCustomerPreferences(uow.sql, input.customerId)
  const rows = await uow.sql<PreferenceRow[]>`
    insert into customer_preference (
      customer_id, preferred_language, preferred_therapist_gender, preferred_room_type,
      pressure_note, oil_note, music_note
    ) values (
      ${input.customerId},
      ${input.preferredLanguage ?? null},
      ${input.preferredTherapistGender ?? null} :: employee_gender,
      ${input.preferredRoomType ?? null} :: room_type,
      ${input.pressureNote ?? null},
      ${input.oilNote ?? null},
      ${input.musicNote ?? null}
    )
    on conflict (customer_id) do update set
      preferred_language = excluded.preferred_language,
      preferred_therapist_gender = excluded.preferred_therapist_gender,
      preferred_room_type = excluded.preferred_room_type,
      pressure_note = excluded.pressure_note,
      oil_note = excluded.oil_note,
      music_note = excluded.music_note
    returning customer_id, preferred_language, preferred_therapist_gender, preferred_room_type,
              pressure_note, oil_note, music_note
  `
  const row = rows[0]
  if (row === undefined) {
    refuse('customer_not_found', `No customer ${input.customerId} to attach preferences to.`, {
      customerId: input.customerId,
    })
  }
  await uow.audit.record({
    action: CRM_AUDIT_ACTIONS.preferencesSet,
    entityType: 'customer_preference',
    entityId: input.customerId,
    operation: before === null ? 'create' : 'update',
    ...(before === null ? {} : { before }),
    after: toPreference(row),
  })
  return toPreference(row)
}

export async function readCustomerPreferences(
  sql: Sql,
  customerId: string,
): Promise<CustomerPreferenceRecord | null> {
  const rows = await sql<PreferenceRow[]>`
    select customer_id, preferred_language, preferred_therapist_gender, preferred_room_type,
           pressure_note, oil_note, music_note
      from customer_preference where customer_id = ${customerId}
  `
  const row = rows[0]
  return row === undefined ? null : toPreference(row)
}

/** Adds a tag. Idempotent: a tag added twice is one row, and the second call writes no audit row. */
export async function addCustomerTag(
  uow: UnitOfWork,
  input: { readonly customerId: string; readonly tag: string },
): Promise<{ readonly added: boolean }> {
  const rows = await uow.sql<{ tag: string }[]>`
    insert into customer_tag (customer_id, tag) values (${input.customerId}, ${input.tag})
    on conflict (customer_id, tag) do nothing
    returning tag
  `
  if (rows.length === 0) return { added: false }
  await uow.audit.record({
    action: CRM_AUDIT_ACTIONS.tagAdded,
    entityType: 'customer_tag',
    entityId: input.customerId,
    operation: 'create',
    after: { tag: input.tag },
  })
  return { added: true }
}

/**
 * Removes a tag. A DELETE, deliberately, unlike a blocklist entry.
 *
 * Correcting a list of labels is a correction and not a history: the audit row is the record that it
 * happened, and keeping a tombstone row per removed tag would make every segment query filter on it.
 */
export async function removeCustomerTag(
  uow: UnitOfWork,
  input: { readonly customerId: string; readonly tag: string },
): Promise<{ readonly removed: boolean }> {
  const rows = await uow.sql<{ tag: string }[]>`
    delete from customer_tag
     where customer_id = ${input.customerId} and tag = ${input.tag}
    returning tag
  `
  if (rows.length === 0) return { removed: false }
  await uow.audit.record({
    action: CRM_AUDIT_ACTIONS.tagRemoved,
    entityType: 'customer_tag',
    entityId: input.customerId,
    operation: 'delete',
    before: { tag: input.tag },
  })
  return { removed: true }
}

export async function readCustomerTags(sql: Sql, customerId: string): Promise<readonly string[]> {
  const rows = await sql<{ tag: string }[]>`
    select tag from customer_tag where customer_id = ${customerId} order by tag
  `
  return rows.map((row) => row.tag)
}

/** Records where a record came from. The vocabulary's foreign key refuses a source nobody declared. */
export async function setAcquisitionSource(
  uow: UnitOfWork,
  input: { readonly customerId: string; readonly source: string },
): Promise<void> {
  // Read first, under the row lock, rather than reading the old value out of RETURNING. A subquery in
  // RETURNING is evaluated against the statement's own snapshot, which makes "the value before" depend
  // on a detail of the executor rather than on the transaction — and the audit row's `before` is the
  // half of it somebody will later rely on.
  const [previous] = await uow.sql<{ acquisition_source: string }[]>`
    select acquisition_source from customer where id = ${input.customerId} for update
  `
  if (previous === undefined) {
    refuse('customer_not_found', `No customer ${input.customerId}.`, {
      customerId: input.customerId,
    })
  }
  await uow.sql`
    update customer set acquisition_source = ${input.source} where id = ${input.customerId}
  `
  await uow.audit.record({
    action: CRM_AUDIT_ACTIONS.acquisitionSourceSet,
    entityType: 'customer',
    entityId: input.customerId,
    operation: 'update',
    before: { acquisition_source: previous.acquisition_source },
    after: { acquisition_source: input.source },
  })
}

/**
 * Sets or clears the VIP flag, with its date.
 *
 * The date is an argument and never `now()`: `packages/db` reads no clock for a fact a test has to be
 * able to freeze, and `customer_vip_since_matches_flag` refuses the flag without it — so the two cannot
 * disagree even if a later caller forgets.
 */
export async function setCustomerVip(
  uow: UnitOfWork,
  input: { readonly customerId: string; readonly isVip: boolean; readonly atIso: string },
): Promise<void> {
  const rows = await uow.sql<{ is_vip: boolean }[]>`
    update customer
       set is_vip = ${input.isVip},
           vip_since = ${input.isVip ? input.atIso : null}
     where id = ${input.customerId}
    returning is_vip
  `
  if (rows.length === 0) {
    refuse('customer_not_found', `No customer ${input.customerId}.`, {
      customerId: input.customerId,
    })
  }
  await uow.audit.record({
    action: CRM_AUDIT_ACTIONS.vipSet,
    entityType: 'customer',
    entityId: input.customerId,
    operation: 'update',
    after: { is_vip: input.isVip, vip_since: input.isVip ? input.atIso : null },
  })
}

// ------------------------------------------------------------------------------------------------
// The lifecycle
// ------------------------------------------------------------------------------------------------

export interface LifecycleResult {
  readonly from: string
  readonly to: string
  /** False when the reducer answered `unchanged`: nothing was written and nothing was audited. */
  readonly moved: boolean
}

/**
 * Applies one lifecycle event to one record, through the injected reducer.
 *
 * The row is locked before its state is read. Without the lock the state is read, judged and written
 * across three statements, and the nightly lapse sweep racing an admin action both read `active`, both
 * decide, and both write — which is how a record a manager just blocked comes back as `lapsed`.
 *
 * A refusal from the reducer is raised as `lifecycle_refused` carrying the reducer's own named refusal,
 * so a sweep can count `customer_is_blocked` separately from a genuine error. An `unchanged` verdict
 * writes **nothing**: no column update and no audit row, because the state the caller asked for is
 * already true and a history of non-changes is a chain that reads as activity.
 */
export async function applyCustomerLifecycleEvent(
  uow: UnitOfWork,
  input: { readonly customerId: string; readonly event: string; readonly atIso: string },
  deps: { readonly decide?: LifecycleDecider },
): Promise<LifecycleResult> {
  if (deps.decide === undefined) {
    refuse(
      'lifecycle_not_decided',
      'No lifecycle decider was injected, so nothing applied the reducer. `packages/db` may not import ' +
        '`packages/core`; pass `decideCustomerLifecycle`.',
      { customerId: input.customerId, event: input.event },
    )
  }
  const [row] = await uow.sql<{ lifecycle_state: string }[]>`
    select lifecycle_state from customer where id = ${input.customerId} for update
  `
  if (row === undefined) {
    refuse('customer_not_found', `No customer ${input.customerId}.`, {
      customerId: input.customerId,
    })
  }
  const verdict = deps.decide(row.lifecycle_state, input.event)
  if (verdict.kind === 'refused') {
    refuse(
      'lifecycle_refused',
      `The lifecycle reducer refused "${row.lifecycle_state}" x "${input.event}": ${verdict.why}`,
      {
        customerId: input.customerId,
        event: input.event,
        from: row.lifecycle_state,
        reducerRefusal: verdict.refusal,
      },
    )
  }
  if (verdict.kind === 'unchanged') {
    return { from: row.lifecycle_state, to: row.lifecycle_state, moved: false }
  }
  await uow.sql`
    update customer
       set lifecycle_state = ${verdict.to}, lifecycle_state_changed_at = ${input.atIso}
     where id = ${input.customerId}
  `
  await uow.audit.record({
    action: CRM_AUDIT_ACTIONS.lifecycleChanged,
    entityType: 'customer',
    entityId: input.customerId,
    operation: 'update',
    before: { lifecycle_state: row.lifecycle_state },
    after: { lifecycle_state: verdict.to, event: input.event, why: verdict.why },
  })
  return { from: row.lifecycle_state, to: verdict.to, moved: true }
}

// ------------------------------------------------------------------------------------------------
// The blocklist
// ------------------------------------------------------------------------------------------------

export interface BlocklistEntryRow {
  readonly id: string
  readonly kind: string
  readonly value: string
  readonly reason: string
  readonly customerId: string | null
  readonly addedByRole: string
}

interface BlocklistDbRow {
  readonly id: string
  readonly key_kind: string
  readonly key_value: string
  readonly reason: string
  readonly customer_id: string | null
  readonly added_by_role: string
}

const toEntry = (row: BlocklistDbRow): BlocklistEntryRow => ({
  id: row.id,
  kind: row.key_kind,
  value: row.key_value,
  reason: row.reason,
  customerId: row.customer_id,
  addedByRole: row.added_by_role,
})

function authorise(role: string, deps: { readonly authorise?: BlocklistAuthoriser }): void {
  if (deps.authorise === undefined) {
    refuse(
      'blocklist_not_authorised',
      'No authoriser was injected, so no role check was applied. `packages/db` may not import ' +
        '`packages/core`; pass `mayChangeBlocklist`. Deny-by-default means denying the caller who ' +
        'forgot to bring the policy, not proceeding without it.',
      { role },
    )
  }
  const verdict = deps.authorise(role)
  if (!verdict.allowed) {
    refuse('blocklist_forbidden', `Role "${role}" may not change the blocklist.`, {
      role,
      authorisationRefusal: verdict.refusal,
    })
  }
}

export interface BlocklistAddInput {
  readonly kind: 'phone' | 'email'
  /** Normalised by `normaliseBlocklistKey` in core. 0053 refuses any other spelling. */
  readonly value: string
  readonly reason: string
  readonly role: string
  readonly customerId?: string | null
}

/**
 * Adds an entry. Refused for a role the injected authoriser does not permit, before anything is written.
 *
 * The `on conflict` is against `customer_blocklist_one_active_per_key`, the PARTIAL unique index, so
 * blocking a key that is already blocked is idempotent and blocking one whose previous entry was lifted
 * creates a new row — which is right: the history of a block and an unblock is two facts.
 */
export async function addBlocklistEntry(
  uow: UnitOfWork,
  input: BlocklistAddInput,
  deps: { readonly authorise?: BlocklistAuthoriser },
): Promise<{ readonly entry: BlocklistEntryRow; readonly created: boolean }> {
  authorise(input.role, deps)
  const reason = stated(input.reason)
  const inserted = await uow.sql<BlocklistDbRow[]>`
    insert into customer_blocklist (key_kind, key_value, customer_id, reason, added_by_role)
    values (${input.kind}, ${input.value}, ${input.customerId ?? null}, ${reason}, ${input.role})
    -- Index inference and not "on conflict on constraint": the target is a PARTIAL unique index and a
    -- partial index cannot be a table constraint, so naming it raises "constraint ... does not exist".
    -- The predicate has to be repeated here for the planner to infer the right index.
    on conflict (key_kind, key_value) where lifted_at is null do nothing
    returning id::text as id, key_kind, key_value, reason, customer_id::text as customer_id,
              added_by_role
  `
  const row = inserted[0]
  if (row === undefined) {
    const existing = await readActiveBlocklistEntries(uow.sql, [
      { kind: input.kind, value: input.value },
    ])
    const entry = existing[0]
    if (entry === undefined) {
      throw new AppError(
        'invariant_violated',
        `Blocklist entry for ${input.kind} conflicted on insert but could not be read back.`,
      )
    }
    return { entry, created: false }
  }
  await uow.audit.record({
    action: CRM_AUDIT_ACTIONS.blocklisted,
    entityType: 'customer_blocklist',
    entityId: row.id,
    operation: 'create',
    after: {
      key_kind: row.key_kind,
      reason: row.reason,
      added_by_role: row.added_by_role,
      customer_id: row.customer_id,
    },
  })
  return { entry: toEntry(row), created: true }
}

/**
 * Lifts an entry. A soft removal, and `delete` is revoked from `berelax_app` so it is the only one.
 *
 * A second lift is refused rather than answered yes: the row is already history, and a silent success
 * would conceal a manager acting on the wrong entry.
 */
export async function liftBlocklistEntry(
  uow: UnitOfWork,
  input: {
    readonly entryId: string
    readonly role: string
    readonly reason: string
    readonly atIso: string
  },
  deps: { readonly authorise?: BlocklistAuthoriser },
): Promise<BlocklistEntryRow> {
  authorise(input.role, deps)
  const reason = stated(input.reason)
  const rows = await uow.sql<BlocklistDbRow[]>`
    update customer_blocklist
       set lifted_at = ${input.atIso}, lifted_by_role = ${input.role}, lifted_reason = ${reason}
     where id = ${input.entryId} and lifted_at is null
    returning id::text as id, key_kind, key_value, reason, customer_id::text as customer_id,
              added_by_role
  `
  const row = rows[0]
  if (row === undefined) {
    refuse(
      'blocklist_entry_not_active',
      `Blocklist entry ${input.entryId} is not there or was already lifted. A second lift is an error, ` +
        'not a no-op: answering yes would conceal a manager acting on the wrong entry.',
      { entryId: input.entryId },
    )
  }
  await uow.audit.record({
    action: CRM_AUDIT_ACTIONS.blocklistLifted,
    entityType: 'customer_blocklist',
    entityId: row.id,
    operation: 'update',
    before: { lifted_at: null },
    after: { lifted_at: input.atIso, lifted_by_role: input.role, lifted_reason: reason },
  })
  return toEntry(row)
}

/**
 * The active entries covering any of these keys. One statement, through the partial index.
 *
 * Returns entries rather than a boolean, because the decision — which kind matched, in which order — is
 * core's `decideBlocklist` and there must be exactly one implementation of it. A `where … limit 1` here
 * would be a second one, and it would have nowhere to put the matched-kind fact the audit row needs.
 */
export async function readActiveBlocklistEntries(
  sql: Sql,
  keys: readonly ContactKey[],
): Promise<readonly BlocklistEntryRow[]> {
  if (keys.length === 0) return []
  const values = keys.map((key) => key.value)
  const kinds = keys.map((key) => key.kind)
  const rows = await sql<BlocklistDbRow[]>`
    select id::text as id, key_kind, key_value, reason, customer_id::text as customer_id,
           added_by_role
      from customer_blocklist
     where lifted_at is null
       and (key_kind, key_value) in (
             select k.kind, k.value
               from unnest(${kinds}::text[], ${values}::text[]) as k(kind, value)
           )
     order by id
  `
  return rows.map(toEntry)
}

export interface BlocklistEvaluation {
  readonly blocked: boolean
  readonly matchedKeyKind: string | null
  readonly entryId: string | null
  /** The stated reason. **Never** put this in a response: it would make the endpoint an oracle. */
  readonly reason: string | null
}

/**
 * Evaluates one booking attempt and audits the evaluation, in the caller's transaction.
 *
 * Read, decide and audit in one function so the audit row cannot be forgotten — the acceptance line is
 * "**every** blocklist evaluation writes an audit_event carrying actor, matched key kind and reason", and
 * a caller-driven three-step would satisfy it on the path somebody remembered.
 *
 * A CLEAR evaluation is audited too, and that is the expensive half of the decision: it is one row per
 * public booking attempt. It is worth it, because the question this trail answers after an incident is
 * "was this number checked at all", and a trail that records only the matches cannot tell a clear
 * evaluation from an evaluation that never happened. The operation is `read` for a clear answer and
 * `denied` for a match, which is the distinction `audit_event`'s own vocabulary already draws and what
 * makes the refusals cheap to find.
 */
export async function evaluateBlocklist(
  uow: UnitOfWork,
  input: { readonly keys: readonly ContactKey[]; readonly context: string },
  deps: { readonly match?: BlocklistMatcher },
): Promise<BlocklistEvaluation> {
  if (deps.match === undefined) {
    refuse(
      'blocklist_not_evaluated',
      'No blocklist matcher was injected, so nothing decided the evaluation. `packages/db` may not ' +
        'import `packages/core`; pass `decideBlocklist`. A booking path that skipped this check would ' +
        'take the booking, which is the one outcome this must not default to.',
      { context: input.context },
    )
  }
  const entries = await readActiveBlocklistEntries(uow.sql, input.keys)
  const verdict = deps.match(
    input.keys,
    entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      value: entry.value,
      reason: entry.reason,
    })),
  )
  const matched = verdict.kind === 'matched'
  await uow.audit.record({
    action: CRM_AUDIT_ACTIONS.blocklistEvaluated,
    entityType: 'customer_blocklist',
    ...(matched ? { entityId: verdict.entryId } : {}),
    operation: matched ? 'denied' : 'read',
    after: {
      context: input.context,
      matched,
      // The KIND, never the value: the trail must say what was checked without becoming a second copy
      // of the contact details it was checking.
      matched_key_kind: matched ? verdict.matchedKeyKind : null,
      key_kinds_checked: matched ? [verdict.matchedKeyKind] : verdict.keyKindsChecked,
      reason: matched ? verdict.reason : null,
    },
  })
  return matched
    ? {
        blocked: true,
        matchedKeyKind: verdict.matchedKeyKind,
        entryId: verdict.entryId,
        reason: verdict.reason,
      }
    : { blocked: false, matchedKeyKind: null, entryId: null, reason: null }
}

// ------------------------------------------------------------------------------------------------
// The therapist do-not-pair flag
// ------------------------------------------------------------------------------------------------

/**
 * Records that a therapist is not to be paired with a customer.
 *
 * Authorised by the **same** permission as a blocklist change, deliberately. A receptionist recording
 * that an employee will not work with a named client is a judgement about the employee as well as about
 * the client, and the manager holds it — the same reason B-LIFE-01 keeps `booking:cancel_as_salon` off
 * the front desk.
 */
export async function setDoNotPair(
  uow: UnitOfWork,
  input: {
    readonly customerId: string
    readonly employeeId: string
    readonly reason: string
    readonly role: string
  },
  deps: { readonly authorise?: BlocklistAuthoriser },
): Promise<{ readonly id: string; readonly created: boolean }> {
  authorise(input.role, deps)
  const reason = stated(input.reason)
  const rows = await uow.sql<{ id: string }[]>`
    insert into customer_therapist_do_not_pair (customer_id, employee_id, reason, set_by_role)
    values (${input.customerId}, ${input.employeeId}, ${reason}, ${input.role})
    -- Index inference, for the reason addBlocklistEntry states: the target is a partial unique index.
    on conflict (customer_id, employee_id) where lifted_at is null do nothing
    returning id::text as id
  `
  const row = rows[0]
  if (row === undefined) {
    const [existing] = await uow.sql<{ id: string }[]>`
      select id::text as id from customer_therapist_do_not_pair
       where customer_id = ${input.customerId} and employee_id = ${input.employeeId}
         and lifted_at is null
    `
    if (existing === undefined) {
      throw new AppError(
        'invariant_violated',
        'A do-not-pair flag conflicted on insert but could not be read back.',
      )
    }
    return { id: existing.id, created: false }
  }
  await uow.audit.record({
    action: CRM_AUDIT_ACTIONS.doNotPairSet,
    entityType: 'customer_therapist_do_not_pair',
    entityId: row.id,
    operation: 'create',
    after: {
      customer_id: input.customerId,
      employee_id: input.employeeId,
      set_by_role: input.role,
      reason,
    },
  })
  return { id: row.id, created: true }
}

/** Lifts a do-not-pair flag. A soft removal for the same reason the blocklist's is. */
export async function liftDoNotPair(
  uow: UnitOfWork,
  input: {
    readonly id: string
    readonly role: string
    readonly reason: string
    readonly atIso: string
  },
  deps: { readonly authorise?: BlocklistAuthoriser },
): Promise<void> {
  authorise(input.role, deps)
  const reason = stated(input.reason)
  const rows = await uow.sql<{ id: string }[]>`
    update customer_therapist_do_not_pair
       set lifted_at = ${input.atIso}, lifted_by_role = ${input.role}, lifted_reason = ${reason}
     where id = ${input.id} and lifted_at is null
    returning id::text as id
  `
  if (rows.length === 0) {
    refuse(
      'do_not_pair_not_active',
      `Do-not-pair flag ${input.id} is not there or already lifted.`,
      {
        id: input.id,
      },
    )
  }
  await uow.audit.record({
    action: CRM_AUDIT_ACTIONS.doNotPairLifted,
    entityType: 'customer_therapist_do_not_pair',
    entityId: input.id,
    operation: 'update',
    before: { lifted_at: null },
    after: { lifted_at: input.atIso, lifted_by_role: input.role, lifted_reason: reason },
  })
}

/** The therapists currently excluded for one customer. Staff-only data; never serialised outward. */
export async function readDoNotPairFor(sql: Sql, customerId: string): Promise<readonly string[]> {
  const rows = await sql<{ employee_id: string }[]>`
    select employee_id::text as employee_id
      from customer_therapist_do_not_pair
     where customer_id = ${customerId} and lifted_at is null
     order by employee_id
  `
  return rows.map((row) => row.employee_id)
}

// ------------------------------------------------------------------------------------------------
// The client record, as one read
// ------------------------------------------------------------------------------------------------

/**
 * Everything the client record holds, field for field the shape of `ClientRecordFacts` in
 * `@berelax/core`.
 *
 * Declared here rather than imported for the reason the whole file states, and asserted structurally
 * assignable to core's by `packages/fixtures/src/crm-client-record.itest.ts` — the same arrangement
 * `TherapistPoolRead` has with `TherapistPool`. A field added to one and not the other is a
 * `pnpm typecheck` failure rather than a DTO that quietly stopped carrying something.
 */
export interface ClientRecordRead {
  readonly label: string
  readonly displayName: string | null
  readonly locale: string
  readonly phoneE164: string
  readonly preferences: {
    readonly preferredLanguage: 'en' | 'ar' | null
    readonly preferredTherapistGender: 'female' | 'male' | null
    readonly preferredRoomType: string | null
    readonly pressureNote: string | null
    readonly oilNote: string | null
    readonly musicNote: string | null
  }
  readonly customerId: string
  readonly lifecycleState: string
  readonly lifecycleChangedAtIso: string
  readonly acquisitionSource: string
  readonly isVip: boolean
  readonly vipSinceIso: string | null
  readonly tags: readonly string[]
  readonly doNotPairTherapistIds: readonly string[]
  readonly blocklistedKeyKinds: readonly string[]
  readonly staffNotes: string | null
}

/**
 * The record, or null.
 *
 * `label` is `Customer NNNN` when there is no display name, never an invented name (ADR 0020). The four
 * digits are the record's, not a person's, and the ordinal is the row's creation rank — `count(*) where
 * id <= this id`, which is well defined because `uuid_generate_v7()` is time-ordered (0002).
 *
 * That rank is stable for as long as no EARLIER row leaves the table, and this system has no path that
 * deletes a customer: a duplicate is merged and the loser becomes a tombstone rather than a hard delete
 * (C-CRM-05). A stored `record_number` column would be stable against a delete as well, and it is
 * deliberately not added here — it would be a second identity for the row, and the only thing that would
 * make it worth having is precisely the delete path this build does not have. Stated rather than left
 * implied, because the day somebody adds `delete from customer` is the day every label after the deleted
 * row shifts by one, and a note a staff member wrote about `Customer 0042` would then be about somebody
 * else.
 */
export async function readClientRecord(
  sql: Sql,
  customerId: string,
): Promise<ClientRecordRead | null> {
  const [row] = await sql<
    {
      id: string
      phone_e164: string
      display_name: string | null
      locale: string
      notes: string | null
      lifecycle_state: string
      lifecycle_state_changed_at: Date
      acquisition_source: string
      is_vip: boolean
      vip_since: Date | null
      ordinal: string
    }[]
  >`
    select c.id::text as id, c.phone_e164, c.display_name, c.locale, c.notes,
           c.lifecycle_state, c.lifecycle_state_changed_at, c.acquisition_source,
           c.is_vip, c.vip_since,
           (select count(*)::text from customer earlier where earlier.id <= c.id) as ordinal
      from customer c where c.id = ${customerId}
  `
  if (row === undefined) return null
  const preferences = await readCustomerPreferences(sql, customerId)
  const blocked = await sql<{ key_kind: string }[]>`
    select distinct key_kind from customer_blocklist
     where customer_id = ${customerId} and lifted_at is null
     order by key_kind
  `
  return {
    label: row.display_name ?? `Customer ${row.ordinal.padStart(4, '0')}`,
    displayName: row.display_name,
    locale: row.locale,
    phoneE164: row.phone_e164,
    preferences: preferences ?? {
      preferredLanguage: null,
      preferredTherapistGender: null,
      preferredRoomType: null,
      pressureNote: null,
      oilNote: null,
      musicNote: null,
    },
    customerId: row.id,
    lifecycleState: row.lifecycle_state,
    lifecycleChangedAtIso: row.lifecycle_state_changed_at.toISOString(),
    acquisitionSource: row.acquisition_source,
    isVip: row.is_vip,
    vipSinceIso: row.vip_since === null ? null : row.vip_since.toISOString(),
    tags: await readCustomerTags(sql, customerId),
    doNotPairTherapistIds: await readDoNotPairFor(sql, customerId),
    blocklistedKeyKinds: blocked.map((entry) => entry.key_kind),
    staffNotes: row.notes,
  }
}

// ------------------------------------------------------------------------------------------------
// Audit coverage over the CRM area
// ------------------------------------------------------------------------------------------------

/** Every audit action this module writes, named once so a test can enumerate them. */
export const CRM_AUDIT_ACTIONS = Object.freeze({
  preferencesSet: 'customer.preferences_set',
  tagAdded: 'customer.tag_added',
  tagRemoved: 'customer.tag_removed',
  acquisitionSourceSet: 'customer.acquisition_source_set',
  vipSet: 'customer.vip_set',
  lifecycleChanged: 'customer.lifecycle_changed',
  blocklisted: 'customer.blocklisted',
  blocklistLifted: 'customer.blocklist_lifted',
  blocklistEvaluated: 'customer.blocklist_evaluated',
  doNotPairSet: 'customer.do_not_pair_set',
  doNotPairLifted: 'customer.do_not_pair_lifted',
} as const)

/**
 * Which table in the CRM area is covered by what.
 *
 * `by: 'repository'` names a representative audited action, and the integration test EXERCISES that
 * action and asserts an `audit_event` delta — a register of intentions would pass for a method somebody
 * later stopped auditing. `by: 'trigger'` names the trigger, and the same test checks `pg_trigger`
 * rather than trusting this list.
 *
 * The AREA is defined by {@link CRM_TABLE_PATTERN} and read from `information_schema`, not from this
 * object, which is the whole point: a table added to the area and not registered here is reported as
 * uncovered rather than being invisible.
 */
export const CRM_AUDIT_COVERAGE: Readonly<
  Record<
    string,
    | { readonly by: 'repository'; readonly action: string }
    | { readonly by: 'trigger'; readonly trigger: string }
  >
> = Object.freeze({
  customer: { by: 'repository', action: CRM_AUDIT_ACTIONS.lifecycleChanged },
  customer_preference: { by: 'repository', action: CRM_AUDIT_ACTIONS.preferencesSet },
  customer_tag: { by: 'repository', action: CRM_AUDIT_ACTIONS.tagAdded },
  customer_blocklist: { by: 'repository', action: CRM_AUDIT_ACTIONS.blocklisted },
  customer_therapist_do_not_pair: { by: 'repository', action: CRM_AUDIT_ACTIONS.doNotPairSet },
  customer_lifecycle_state: { by: 'trigger', trigger: 'customer_lifecycle_state_audit' },
  customer_acquisition_source: { by: 'trigger', trigger: 'customer_acquisition_source_audit' },
})

/**
 * What counts as the CRM area: `customer` and everything named beneath it.
 *
 * A prefix rather than a list, so the next CRM table is in the area the moment it is created — which is
 * what makes the coverage test able to fail for a table nobody registered. It is stated as a POSIX
 * pattern because the enumeration runs in SQL: the area has to be read from the database, not from a
 * TypeScript array that a new table would not appear in.
 */
export const CRM_TABLE_PATTERN = '^customer(_|$)'

export interface CrmAuditCoverageRow {
  readonly table: string
  readonly covered: boolean
  readonly by: 'repository' | 'trigger' | null
  /** The action or trigger name that covers it, or why nothing does. */
  readonly detail: string
}

/**
 * Enumerates every mutable table in the CRM area and says how each is audited.
 *
 * "Mutable" excludes nothing here by accident: the area contains no append-only table, and one added
 * later would still be enumerated — an append-only table is written by INSERT and an insert nobody
 * audits is exactly what this is for. Views and the `audit_event` partitions are not BASE TABLEs in this
 * schema and do not appear.
 *
 * The trigger arm is checked against `pg_trigger` and the function it calls, so a register entry naming
 * a trigger that was dropped reports the table as uncovered.
 */
export async function crmAuditCoverage(sql: Sql): Promise<readonly CrmAuditCoverageRow[]> {
  const rows = await sql<{ table_name: string; audit_triggers: string[] }[]>`
    select t.table_name,
           coalesce(
             array_agg(g.tgname order by g.tgname) filter (where g.tgname is not null),
             array[]::text[]
           ) as audit_triggers
      from information_schema.tables t
      left join pg_class c on c.relname = t.table_name and c.relnamespace = 'public'::regnamespace
      left join pg_trigger g
        on g.tgrelid = c.oid
       and not g.tgisinternal
       -- Only a trigger that actually writes the audit trail counts: set_updated_at is a trigger too,
       -- and a register entry satisfied by it would be coverage in name only. No backticks in this
       -- string, deliberately - a backtick inside a JS template literal ENDS it, and the statement then
       -- parses as something else entirely.
       and g.tgfoid = 'record_crm_vocabulary_change'::regproc
     where t.table_schema = 'public'
       and t.table_type = 'BASE TABLE'
       and t.table_name ~ ${CRM_TABLE_PATTERN}
     group by t.table_name
     order by t.table_name
  `
  return rows.map((row) => {
    const registered = Object.hasOwn(CRM_AUDIT_COVERAGE, row.table_name)
      ? CRM_AUDIT_COVERAGE[row.table_name]
      : undefined
    if (registered === undefined) {
      return {
        table: row.table_name,
        covered: false,
        by: null,
        detail:
          `${row.table_name} is in the CRM area and CRM_AUDIT_COVERAGE does not register it. Add an ` +
          'audited repository method or an audit trigger — an unaudited CRM table is a client record ' +
          'somebody can change with nothing recording that they did.',
      }
    }
    if (registered.by === 'trigger') {
      const present = row.audit_triggers.includes(registered.trigger)
      return {
        table: row.table_name,
        covered: present,
        by: present ? 'trigger' : null,
        detail: present
          ? registered.trigger
          : `${row.table_name} is registered as audited by trigger ${registered.trigger}, and no such ` +
            'trigger calling record_crm_vocabulary_change exists on it.',
      }
    }
    return {
      table: row.table_name,
      covered: true,
      by: 'repository',
      detail: registered.action,
    }
  })
}
