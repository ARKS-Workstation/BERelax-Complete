import { AppError } from '@berelax/shared'
import type { Sql } from './connection.ts'
import { PGBOSS_SCHEMA } from './jobs/boss.ts'

/**
 * The merge participant registry (C-CRM-05): every table a merge has to do something about, what it
 * does, and — for the ones it deliberately does nothing about — why.
 *
 * ## Why a registry exists at all
 *
 * A merge is the operation whose defects are invisible. Re-point eight tables out of nine and the ninth
 * one's rows stay on a record nothing reads: the appointment is still in the diary, the tag is still on
 * the tombstone, the consent is still attached to the id the send path stopped resolving. Nothing fails,
 * nothing logs, and the symptom surfaces months later as a promotional message to somebody who opted
 * out, or a contraindication that did not reach the front desk.
 *
 * The failure is not a bug in the merge as first written — it is what happens when a table is added
 * afterwards. Every unit in this build that adds a customer-scoped table adds one to the set of things a
 * merge must handle, and nothing in a normal review of that unit's diff would say so. So the set is
 * enumerated FROM THE DATABASE by {@link mergeCoverage}, compared against this registry, and a table
 * carrying a customer or contact id that appears in neither {@link MERGE_PARTICIPANTS} nor
 * {@link MERGE_ALLOWLIST} fails `packages/fixtures/src/merge.itest.ts`. The registry is not the
 * authority on what exists; the catalogue is. That is the difference between a check and a list.
 *
 * ## The four strategies, and why an UPDATE is not one of them for every table
 *
 * - **`repoint_update`** — the ordinary case. `update <table> set <column> = survivor where <column> =
 *   loser`, skipping any row whose key is already taken on the survivor, because the unique index would
 *   refuse it.
 * - **`repoint_insert`** — an append-only table. `consent` refuses UPDATE for every role including the
 *   owner (0056, ZP003), so the loser's log is COPIED onto the survivor with the original left where it
 *   is. That is not a workaround: the record has to outlive the erasure of the identity it is about, and
 *   the copy carries the same `recorded_at`, so `resolveConsent` over the merged log sees one person's
 *   real chronology.
 * - **`insert_backreference`** — `suppression`, and it is the one that re-points nothing. 0064 keys it
 *   on the HASHED DETAIL and not on a contact, deliberately and differently from consent: both details
 *   survive a merge with their suppressions attached, so the list already answers correctly for the
 *   merged person. The only thing a merge owes it is the `contact_customer_id` back-reference on the
 *   survivor, and that is an INSERT because the table refuses UPDATE (ZQ001).
 * - **`union_dedupe`** — a ledger whose rows are EVENTS with a natural key. Mechanically the same
 *   statement as `repoint_update` with the natural key as the conflict key; the difference is what a
 *   conflict MEANS and therefore what the record says about it. For a keyed profile table a conflict is
 *   a value discarded; here it is the same event recorded twice, and counting it once is the whole
 *   point. C-AUTO-03's `frequency_ledger` is the participant this exists for and it does not exist yet —
 *   {@link unionByNaturalKey} in `@berelax/core` is where the rule is proved in the meantime.
 *
 * ## The allowlist is not an exemption list
 *
 * Every entry names a reason a merge must NOT touch that table, and most of those reasons are structural
 * rather than preferential: the application role holds no UPDATE privilege on `invoice` or
 * `checkout_finalisation`, holds NO privilege at all on the `clinical` schema (0009 revokes it), and
 * cannot edit `merge_record` at all (ZT001). The read side resolves the tombstone instead —
 * `merge_survivor_of(uuid)` in 0069 is granted to `berelax_clinical` for exactly that, because the
 * clinical schema cannot call TypeScript.
 *
 * ## Identifiers are validated before they reach a statement
 *
 * The executor in `repositories/merge.ts` builds SQL with `sql.unsafe`, because a dynamic table name, a
 * dynamic column list and a partial-index predicate cannot all be parameterised. Every identifier in
 * this file is therefore checked against {@link SQL_IDENTIFIER} and every predicate against
 * {@link SQL_PREDICATE} by {@link assertParticipantIsWellFormed}, which the executor calls for each
 * participant before it issues anything. The two customer ids are always bound parameters and never
 * interpolated.
 */

/** A bare lower-case SQL identifier. Nothing in this registry may be anything else. */
export const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/**
 * The shape a partial-index predicate may take: `<column> is null` or `<column> is not null`.
 *
 * Deliberately this narrow rather than "any boolean expression". Only one participant needs one today
 * (`customer_therapist_do_not_pair`'s unique index is partial on `lifted_at is null`), and a predicate
 * grammar wide enough to be useful is also wide enough to carry a subquery into `sql.unsafe`.
 */
export const SQL_PREDICATE = /^[a-z_][a-z0-9_]* is (not )?null$/

export const MERGE_STRATEGIES = [
  'repoint_update',
  'repoint_insert',
  'insert_backreference',
  'union_dedupe',
] as const
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number]

export interface MergeParticipant {
  /** Always `public`: a strategy that writes cannot reach another schema. Asserted, not assumed. */
  readonly schema: 'public'
  readonly table: string
  /** The column holding the customer id — `customer_id` or `contact_customer_id`. */
  readonly column: string
  readonly strategy: MergeStrategy
  /**
   * The OTHER columns of the unique key a re-point could collide with, or null when there is none.
   *
   * An empty array is not the same as null and both occur: `customer_preference`'s primary key is the
   * customer id alone, so the conflict test is on nothing else (`[]`); `booking` has no unique key
   * involving the customer at all, so no conflict is possible (`null`) and the statement needs no
   * subquery.
   */
  readonly conflictKey: readonly string[] | null
  /** The predicate of a PARTIAL unique index, or null. Only rows it selects can collide. */
  readonly activePredicate: string | null
  /** For `repoint_insert`: the columns identifying a row already present on the survivor. */
  readonly dedupeKey: readonly string[] | null
  /** For `insert_backreference`: what a detail is, and which column orders its log. */
  readonly backReference: {
    readonly groupBy: readonly string[]
    readonly orderBy: string
    /** Set to the merge instant on the copy, because the log's unique key includes the instant. */
    readonly stampColumn: string
  } | null
  /** Columns the copy must NOT carry: a generated id and the instant the ROW landed. */
  readonly excludeColumns: readonly string[]
  /** What a retained row means for this table, required whenever one can be retained. */
  readonly retainedReason: string | null
  readonly why: string
  /** The unit that registered it, so a question about an entry has somewhere to go. */
  readonly registeredBy: string
}

const participant = (p: MergeParticipant): MergeParticipant => Object.freeze(p)

/**
 * Freezes the registry, refusing a (schema, table, column) registered twice.
 *
 * At module load, and throwing, for the reason `define()` in the settings registry throws: a duplicate
 * entry here is legal TypeScript that breaks every merge the business attempts. `applyMergeParticipant`
 * takes its counts from the database on both sides of the work, so a table applied twice re-points its
 * rows on the first pass and moves ZERO on the second — and 0069's
 * `rows_before_loser = rows_moved + rows_retained_on_loser` is then violated by the second report, which
 * rolls the whole merge back. The symptom is "merge refused" on every pair, with a constraint name that
 * says nothing about a duplicated list.
 *
 * It has happened: a clean auto-merge of two branches left a duplicate entry in this file, and nothing in
 * either diff said so — the file is a flat list of near-identical objects and the duplicate reads as one
 * more table. A module that refuses to load is a far cheaper failure than a merge nobody can perform, and
 * it fails in `pnpm test` rather than in front of the front desk.
 */
function registry(participants: readonly MergeParticipant[]): readonly MergeParticipant[] {
  const seen = new Set<string>()
  const duplicated: string[] = []
  for (const p of participants) {
    const key = `${p.schema}.${p.table}.${p.column}`
    if (seen.has(key)) duplicated.push(key)
    seen.add(key)
  }
  if (duplicated.length > 0) {
    throw new AppError(
      'invariant_violated',
      `The merge participant registry declares ${duplicated.join(', ')} more than once. A table applied ` +
        'twice re-points its rows on the first pass and moves zero on the second, which violates ' +
        'merge_record_table\u2019s rows_before_loser = rows_moved + rows_retained_on_loser and rolls every ' +
        'merge back. Remove the duplicate; do not reconcile the counts.',
      { details: { duplicated, refusal: 'merge_participant_duplicated' } },
    )
  }
  return Object.freeze(participants)
}

/**
 * Every table a merge acts on, in the order it acts on them.
 *
 * `consent` is deliberately NOT last. The transaction test injects a failure immediately after the
 * consents are re-pointed, which is only a meaningful test if something comes after them — and the
 * ordering is also the one a reader wants: the profile tables, then the append-only records, then the
 * back-reference that depends on nothing.
 */
export const MERGE_PARTICIPANTS: readonly MergeParticipant[] = registry([
  participant({
    schema: 'public',
    table: 'booking',
    column: 'customer_id',
    strategy: 'repoint_update',
    conflictKey: null,
    activePredicate: null,
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason: null,
    why:
      'A booking and the appointments hanging off it must follow the person: the survivor is the record ' +
      'the diary, the availability read and every reminder resolve through. No unique key involves the ' +
      'customer, so no row can be refused.',
    registeredBy: 'C-CRM-05',
  }),
  participant({
    schema: 'public',
    table: 'booking_session',
    column: 'customer_id',
    strategy: 'repoint_update',
    conflictKey: null,
    activePredicate: null,
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason: null,
    why:
      'A public booking session in flight continues on the survivor. Left behind, a customer part-way ' +
      'through a booking would finish it against a tombstone and the appointment would hang off a ' +
      'record nothing reads.',
    registeredBy: 'C-CRM-05',
  }),
  participant({
    schema: 'public',
    table: 'customer_blocklist',
    column: 'customer_id',
    strategy: 'repoint_update',
    conflictKey: null,
    activePredicate: null,
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason: null,
    why:
      '0053 matches a blocklist entry on the hashed DETAIL and keeps this column only to say which ' +
      'record it is about, so the entry already blocks the merged person either way. Re-pointing it is ' +
      'what keeps the staff view of "why is this record blocked" attached to the record that survives. ' +
      'Its unique index is on (key_kind, key_value) and not on the customer, so nothing can collide.',
    registeredBy: 'C-CRM-05',
  }),
  participant({
    schema: 'public',
    table: 'customer_preference',
    column: 'customer_id',
    strategy: 'repoint_update',
    // The primary key IS the customer id, so the conflict test is on no further column.
    conflictKey: [],
    activePredicate: null,
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason:
      'The survivor already has a preference row. The provisional rule resolves a conflict to the ' +
      'survivor, and the loser’s preferences stay readable on the tombstone rather than overwriting ' +
      'choices somebody made more recently.',
    why: 'One row per customer, so the survivor’s row wins and the loser’s is retained on the tombstone.',
    registeredBy: 'C-CRM-05',
  }),
  participant({
    schema: 'public',
    table: 'customer_pipeline_card',
    column: 'customer_id',
    strategy: 'repoint_update',
    // The primary key IS the customer id, so the conflict test is on no further column —
    // `customer_preference`'s case, and for the same structural reason: one row per person.
    conflictKey: [],
    activePredicate: null,
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason:
      'The survivor already has a card. Merging two records does NOT advance a stage, and this is the ' +
      'decision worth reading twice: the obvious rule is "keep the furthest-along of the two", and that ' +
      'would be the SYSTEM making a claim about a person. A stage is where a human put somebody — every ' +
      'one of them is recorded with an actor in pipeline_stage_transition — so a merge may move a card ' +
      'and may not decide one. The survivor keeps the column somebody last dragged them to, and the ' +
      'loser’s card stays readable on the tombstone.',
    why:
      'A card must follow the person, or the board draws the tombstone: the row survives a merge and so ' +
      'does the loser’s `customer` row, so a card left behind is a second card for one human that the ' +
      'front desk can drag — and a drag on the wrong one moves a card nothing else reads. ' +
      '`readPipelineBoard` filters merged-away contacts out for exactly that case (the retained one), ' +
      'and the re-point is what makes the ordinary case need no filtering at all. The move is invisible ' +
      'to `customer_pipeline_card_records_every_move`: that trigger returns early when neither ' +
      '`stage_key` nor `stage_entered_at` changes, which is what a re-point is, so a merge does not have ' +
      'to fabricate a transition saying a stage was entered when nobody entered it.',
    registeredBy: 'C-AUTO-08',
  }),
  participant({
    schema: 'public',
    table: 'customer_tag',
    column: 'customer_id',
    strategy: 'repoint_update',
    conflictKey: ['tag'],
    activePredicate: null,
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason:
      'The survivor already carries that tag. One person with one record carries a tag once, so the ' +
      'duplicate stays on the tombstone rather than being moved onto a key that already exists.',
    why: 'Tags union: the survivor gains every tag the loser held and a shared tag is not duplicated.',
    registeredBy: 'C-CRM-05',
  }),
  participant({
    schema: 'public',
    table: 'customer_therapist_do_not_pair',
    column: 'customer_id',
    strategy: 'repoint_update',
    conflictKey: ['employee_id'],
    // The unique index is partial: only a LIVE exclusion can collide, and a lifted one re-points freely.
    activePredicate: 'lifted_at is null',
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason:
      'The survivor already holds a live exclusion for that therapist. The exclusion is in force either ' +
      'way, which is the direction that matters: a duplicate row would be refused by the partial unique ' +
      'index, and dropping the exclusion is the one outcome this must never produce.',
    why:
      'A do-not-pair exclusion is a safety and comfort decision that must survive the merge — ' +
      'availability reads it through C-CRM-01’s exclusion, and losing one puts a customer back with a ' +
      'therapist they asked not to see.',
    registeredBy: 'C-CRM-05',
  }),
  participant({
    schema: 'public',
    table: 'waitlist',
    column: 'customer_id',
    strategy: 'repoint_update',
    // NULLS NOT DISTINCT on the real index, which `is not distinct from` reproduces exactly.
    conflictKey: ['service_variant_id', 'trading_date', 'desired_period', 'therapist_id'],
    activePredicate: null,
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason:
      'The survivor already waits for that exact window. Two rows for one person on one window would be ' +
      'two offers of the same slot, which is the thing waitlist_one_row_per_window exists to refuse.',
    why: 'A waitlist entry must follow the person, or the offer goes to a record nobody is reading.',
    registeredBy: 'C-CRM-05',
  }),
  participant({
    schema: 'public',
    table: 'package_sale',
    column: 'customer_id',
    strategy: 'repoint_update',
    /**
     * No unique key involves the customer. `package_sale_one_per_entry` is on `journal_entry_id` and the
     * two indexes that mention `customer_id` are plain, so a re-point cannot be refused and the statement
     * needs no conflict subquery. A person legitimately buys the same package twice.
     */
    conflictKey: null,
    activePredicate: null,
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason: null,
    why:
      'A prepaid package is money the customer has already handed over and treatments the salon still ' +
      'owes, so it has to follow the person: a balance left on a tombstone is an entitlement somebody ' +
      'paid for and can no longer draw on. The `invoice` and `credit_note` allowlist entries deliberately ' +
      'do NOT apply — those snapshot the customer’s name, phone and TRN onto a filed document and the ' +
      'FTA reads those columns, so a re-attributed invoice is a different document; a package sale ' +
      'snapshots no customer identity at all, only the terms. `package_sale` therefore refuses every ' +
      'UPDATE except one that changes `customer_id` alone (ZG001, and the application role holds ' +
      '`update (customer_id)` and nothing more), which is exactly the statement this strategy issues. ' +
      '`package_balance` carries no customer id and hangs off the sale, so it follows without being ' +
      'named here.',
    registeredBy: 'M-TILL-09',
  }),
  participant({
    schema: 'public',
    table: 'flow_enrolment',
    column: 'customer_id',
    strategy: 'repoint_update',
    // `flow_enrolment_one_active_per_contact` (0091), minus the customer: a contact may be on one flow
    // once at a time, so the only thing an active enrolment can collide with is the survivor's own active
    // enrolment on the SAME flow. It was `null` here, and it was right until 0091 added the index — which
    // is the direction this field has to be kept in step, because a null conflict key against a real
    // unique index is a 23505 in the middle of a merge instead of a retained row with a stated reason.
    conflictKey: ['flow_id'],
    // The index is PARTIAL on `ended_at is null`, which is exactly `status = 'active'` (0070's
    // `flow_enrolment_ended_matches_status` is that biconditional). A COMPLETED enrolment is outside the
    // index, cannot collide with anything and must move — `customer_therapist_do_not_pair`'s lifted-row
    // case, and for the same structural reason.
    activePredicate: 'ended_at is null',
    dedupeKey: null,
    backReference: null,
    // `merge_record_table_retained_reason_is_stated` caps this at 300 characters, so the argument lives in
    // `why` below and this is the sentence a merge report carries.
    retainedReason:
      'The survivor is already running on that flow. Moving the loser’s enrolment would put one person on ' +
      'one flow twice and send them every node twice; the survivor’s run continues and the loser’s stays ' +
      'readable on the tombstone, where the interpreter ends it with contact_merged_away.',
    excludeColumns: [],
    why:
      'An enrolment is a process attached to a contact (0070), so it must follow the person: left on the ' +
      'tombstone, a win-back sequence would go on sending to a record nothing else reads, resolving ' +
      'consent and suppression against a log the survivor no longer owns. Registered by C-CRM-06 rather ' +
      'than by C-CRM-05 because 0070 landed FIRST and nothing registered it: `mergeCoverage` enumerates ' +
      'from information_schema, so the completeness case in merge.itest.ts went red the moment the two ' +
      'branches met — which is exactly what that mechanism is for, and this is the first time it fired ' +
      'on a real table. The half C-AUTO-07 owed it has landed: `flow_run` hangs off this row and follows ' +
      'it, and `flow_node_effect` below carries the (flow_run, node, channel, contact) token, so a node ' +
      'already executed for the loser is not executed again for the survivor. ' +
      'The pin (flow_id, definition_version) is immutable (ZF002) and is NOT touched: re-pointing the ' +
      'customer leaves the version this enrolment is governed by exactly where it was.',
    registeredBy: 'C-CRM-06',
  }),
  participant({
    schema: 'public',
    table: 'flow_node_effect',
    column: 'contact_customer_id',
    strategy: 'repoint_update',
    // `flow_node_effect_once_per_contact` (0091), minus the contact. The run, the node and the channel are
    // the rest of the acceptance line's key, and `assertParticipantKeyIsAUniqueIndex` refuses this
    // registration the day that constraint's columns stop matching.
    conflictKey: ['flow_run_id', 'node_id', 'channel'],
    // The index is total, so every row is in it and every row can collide. Nothing to narrow.
    activePredicate: null,
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason:
      'The same (run, node, channel) already has a token on the survivor, so the same node of the same run ' +
      'was recorded against both records — an at-least-once job replayed across a merge that had already ' +
      'moved the contact. One token is what the run needs; a second would claim one execution twice.',
    why:
      'The token says THIS node of THIS run has already reached THIS contact, and after a merge the ' +
      'contact IS the survivor — so the token has to move or the next tick computes a key that finds ' +
      'nothing and sends the message again. That is the whole of C-AUTO-07’s "a contact merged mid-run ' +
      'continues on the survivor exactly once", and it is the one thing on this table a merge may touch: ' +
      'the table refuses DELETE and refuses an UPDATE of the run, the node, the channel or the instant ' +
      '(ZY012), and the application role holds `update (contact_customer_id)` and nothing more, which is ' +
      'exactly the statement this strategy issues (package_sale’s arrangement in 0078, ZG001). ' +
      'The alternative — leaving the tokens on the tombstone — is not a missing tidy-up: it is the ' +
      'survivor being sent every message the loser had already received.',
    registeredBy: 'C-AUTO-07',
  }),
  participant({
    schema: 'public',
    table: 'frequency_ledger',
    column: 'contact_customer_id',
    strategy: 'union_dedupe',
    // The natural key of a SEND, minus the contact: after the merge both sides ARE the survivor's rows, so
    // keying on the contact would make every pair of rows look distinct and fold nothing. It is exactly
    // `frequency_ledger_one_counted_send`, and `assertParticipantKeyIsAUniqueIndex` refuses this
    // registration if that index's columns ever stop matching.
    conflictKey: ['send_key'],
    // The index is PARTIAL on counted rows, so only a COUNTED send can collide. A refusal row re-points
    // freely — `customer_therapist_do_not_pair`'s lifted-row case, and for the same structural reason: a
    // row outside the unique index cannot be in conflict with anything and must move.
    activePredicate: 'counted_at is not null',
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason:
      'The same send is already counted against the survivor under this natural key, so the loser\u2019s row ' +
      'is the SAME message recorded twice \u2014 an at-least-once job replayed against a contact id a merge ' +
      'had already moved. Counted once: moving the second would double a message the rolling cap reads and ' +
      'silence the contact for a fortnight on the strength of one send, with a support ticket nobody can ' +
      'answer because the ledger says two sends happened.',
    why:
      'A ledger row says this contact was sent a promotional message at this instant, and after a merge ' +
      'the contact IS the survivor \u2014 so re-pointing it makes nothing untrue and makes the cap read one ' +
      'person\u2019s real history. The two alternatives are both wrong in a direction somebody pays for. ' +
      'Left on the tombstone the rows are invisible to the cap, which hands the merged contact a FRESH ' +
      'ALLOWANCE and turns a merge into a way to message somebody past the cap. Copied the way `consent` ' +
      'is copied, one message would count twice. `union_dedupe` is the strategy 0069 reserved for this ' +
      'table and this is the only participant that uses it: mechanically `repoint_update` with a natural ' +
      'conflict key, and different in what a conflict MEANS \u2014 for a keyed profile table a conflict is a ' +
      'value discarded, here it is the same event recorded twice and counting it once is the whole point.',
    registeredBy: 'C-AUTO-03',
  }),
  participant({
    schema: 'public',
    table: 'consent',
    column: 'contact_customer_id',
    strategy: 'repoint_insert',
    conflictKey: null,
    activePredicate: null,
    // 0056's `consent_one_record_per_instant`, minus the contact. A row already present on the survivor
    // under the same (channel, purpose, kind, instant) IS the loser's row, re-pointed by an earlier
    // merge or captured twice, and copying it again would be refused by that index.
    dedupeKey: ['channel', 'purpose', 'kind', 'recorded_at'],
    backReference: null,
    // `id` is generated and `created_at` is when the ROW lands — which for a copy is now, not then.
    // `recorded_at` is the person's decision and IS copied: it is the resolver's only ordering key.
    excludeColumns: ['id', 'created_at'],
    retainedReason: null,
    why:
      'Append-only (0056, ZP003), so the log is COPIED rather than moved and the originals stay on the ' +
      'tombstone. The copy keeps `recorded_at`, so resolveConsent over the merged log reads one ' +
      'person’s real chronology — which is what makes a withdrawal on either record govern the ' +
      'survivor when it is the newest thing either of them said.',
    registeredBy: 'C-CRM-05',
  }),
  participant({
    schema: 'public',
    table: 'suppression',
    column: 'contact_customer_id',
    strategy: 'insert_backreference',
    conflictKey: null,
    activePredicate: null,
    dedupeKey: null,
    backReference: Object.freeze({
      groupBy: Object.freeze(['key_kind', 'key_hmac']),
      orderBy: 'recorded_at',
      stampColumn: 'recorded_at',
    }),
    excludeColumns: ['id', 'created_at'],
    retainedReason: null,
    why:
      '0064 keys this on the hashed DETAIL and not on a contact, and says so as the answer to C-CRM-03’s ' +
      'question — answered DIFFERENTLY from consent, for a reason rather than by inconsistency. Both ' +
      'details survive a merge with their suppressions attached, so the list already refuses the merged ' +
      'person’s mail either way and a merge re-points NOTHING here. What it owes is the ' +
      '`contact_customer_id` back-reference on the survivor, restating the NEWEST entry per detail so ' +
      'the resolved state is unchanged and only the attribution moves.',
    registeredBy: 'C-CRM-05',
  }),
])

export interface MergeAllowlistEntry {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly reason: string
  readonly registeredBy: string
}

/**
 * Tables carrying a customer or contact id that a merge deliberately does not touch, each with why.
 *
 * Nothing is here for convenience. Read the reasons as a set and they say one thing: a merge changes who
 * a record is, and it may not change what a document SAYS, what a ciphertext is bound to, or what a link
 * already in somebody's hand resolves to. Those readers follow the tombstone instead.
 */
export const MERGE_ALLOWLIST: readonly MergeAllowlistEntry[] = Object.freeze([
  Object.freeze({
    schema: 'public',
    table: 'flow_step_log',
    column: 'contact_customer_id',
    reason:
      'The step log is EVIDENCE, not state a decision is taken from. It is append-only for every role ' +
      'including the owner (0091, ZY011) and the application role holds no UPDATE privilege on it, so ' +
      'there is no statement a merge could issue — but the structural half is not the argument. The ' +
      'argument is that "why did this contact get this message" about the tombstone is a TRUE statement ' +
      'about the past: those rows name the version, the node, the consent record and the gate decision ' +
      'that were in force for the record the message actually went to, and re-attributing them would ' +
      'make the survivor’s history say a message was sent under a consent record that belonged to ' +
      'somebody else. The `invoice` entry below takes the same decision about a filed document. A read ' +
      'that wants one person’s whole automation history resolves the tombstone with ' +
      'merge_survivor_of(uuid), which is what that function is for. What a merge DOES move is the ' +
      'idempotency token (`flow_node_effect`), because that one is read to decide whether to send.',
    registeredBy: 'C-AUTO-07',
  }),
  Object.freeze({
    schema: 'public',
    table: 'invoice',
    column: 'customer_id',
    reason:
      'A tax invoice is append-only (invoice_no_update raises) and the application role holds no UPDATE ' +
      'privilege on it. It also snapshots the customer’s name, phone and TRN as they were when it was ' +
      'issued, and those columns are what the FTA reads: an invoice re-attributed to another record is ' +
      'a different document. A history read that wants one person’s invoices resolves the tombstone.',
    registeredBy: 'C-CRM-05',
  }),
  Object.freeze({
    schema: 'public',
    table: 'credit_note',
    column: 'customer_id',
    reason:
      'The `invoice` entry above, for the document that corrects one. A credit note is append-only ' +
      '(credit_note_no_update raises ZD009 for every role) and the application role holds no UPDATE ' +
      'privilege on it; it snapshots the customer\u2019s name, phone and TRN as they were when the ' +
      'correction was issued, and it is filed with the same return the invoice is. A note re-attributed ' +
      'to another record is a different document, and a merge may not make one.',
    registeredBy: 'M-TILL-08',
  }),
  Object.freeze({
    schema: 'public',
    table: 'checkout_finalisation',
    column: 'customer_id',
    reason:
      '0063 revokes UPDATE and DELETE from the application role: the row is the till’s idempotency ' +
      'claim over a completed sale, and its customer id is the one the sale’s events carried. Editing it ' +
      'would change the history of a drawer that has already been counted.',
    registeredBy: 'C-CRM-05',
  }),
  Object.freeze({
    schema: 'public',
    table: 'optout_grant',
    column: 'contact_customer_id',
    reason:
      '0064 puts the contact in the opt-out URL as well as the token and refuses the request unless the ' +
      'two agree, so a link already in somebody’s hand would STOP WORKING if the grant were re-pointed ' +
      '— and a link that has stopped working is an opt-out this business does not have. The link keeps ' +
      'resolving to the tombstone, and the suppression it writes keys on the hashed detail, so the send ' +
      'is refused for the survivor too.',
    registeredBy: 'C-CRM-05',
  }),
  Object.freeze({
    schema: 'public',
    table: 'pipeline_stage_transition',
    column: 'customer_id',
    reason:
      '0077 makes this log append-only for every role including the owner (ZU002) and the application ' +
      'role holds no UPDATE, DELETE or TRUNCATE on it, so a merge — an application operation — cannot ' +
      'move a row here even if it wanted to. It should not want to: a transition says a NAMED actor moved ' +
      'this record from one column to another at an instant, and re-pointing it would make the survivor’s ' +
      'history contain a move nobody made on that card. It is the `invoice` argument for a log rather ' +
      'than a document: what the row says happened does not stop being true because two records turned ' +
      'out to be one person. The CARD follows the person (the participant above), which is what the board ' +
      'reads; a history read that wants one person’s whole pipeline resolves the tombstone, exactly as ' +
      'an invoice history does. The cost is stated rather than hidden: `readCardHistory` for the survivor ' +
      'does not include the loser’s moves, and nothing in this build reads that history to make a ' +
      'decision — the card is where the person is.',
    registeredBy: 'C-AUTO-08',
  }),
  Object.freeze({
    schema: 'public',
    table: 'merge_record',
    column: 'survivor_customer_id',
    reason:
      'The merge record IS the tombstone. Re-pointing it would rewrite the history of the merges — and ' +
      'it is append-only for every role (ZT001), so nothing can. A later merge of the survivor adds a ' +
      'row and merge_survivor_of() follows the chain.',
    registeredBy: 'C-CRM-05',
  }),
  Object.freeze({
    schema: 'public',
    table: 'merge_record',
    column: 'loser_customer_id',
    reason:
      'The tombstone’s own id, UNIQUE. Moving it would either erase the fact that a record was merged ' +
      'away or claim a second record had been. Append-only for every role (ZT001).',
    registeredBy: 'C-CRM-05',
  }),
  Object.freeze({
    schema: 'clinical',
    table: 'contraindication_flag',
    column: 'customer_id',
    reason:
      '0009 revokes ALL privileges on the clinical schema from the application role, so a merge — an ' +
      'application operation — cannot reach this table at all. The flags are read through ' +
      'public.customer_contraindication_flags, a SECURITY DEFINER view, and that read is where a merged ' +
      'record must be resolved: merge_survivor_of() is granted to berelax_clinical for it. Nothing in ' +
      'the build reads the view yet, which is why the deferral is named in the manifest rather than ' +
      'silently carried.',
    registeredBy: 'C-CRM-05',
  }),
  Object.freeze({
    schema: 'clinical',
    table: 'intake_submission',
    column: 'customer_id',
    reason:
      'Unreachable for the same privilege reason, and impossible for a second: 0043 binds the ciphertext ' +
      'to `table | record id | customer id` as its AAD and its sealed-row trigger raises ZK002 on an ' +
      'UPDATE that changes anything outside the mutable set. A re-pointed submission would be a record ' +
      'nothing can decrypt.',
    registeredBy: 'C-CRM-05',
  }),
  Object.freeze({
    schema: 'clinical',
    table: 'treatment_note',
    column: 'customer_id',
    reason:
      'The same two reasons as intake_submission: no privilege, and the AAD binds the ciphertext to the ' +
      'customer id. A clinical note is corrected by superseding it, never by rewriting it.',
    registeredBy: 'C-CRM-05',
  }),
  Object.freeze({
    schema: 'clinical',
    table: 'treatment_consent',
    column: 'customer_id',
    reason:
      'Unreachable from the application role (0009). It is also kept beside the data it authorises so ' +
      'that a relocation moves both together, which is an argument against a CRM operation reaching ' +
      'across to edit one.',
    registeredBy: 'C-CRM-05',
  }),
  // --- C-CRM-10's three, and this check is why they are here at all ------------------------------
  //
  // Migration 0085 added three tables carrying a customer reference and registered none of them. Nothing
  // in C-CRM-10's own suite could see that; `merge.itest.ts` failed on the next full run with "a table
  // carrying a customer id that nothing in the registry accounts for", naming all three. That is this
  // registry's entire purpose working, from the other side.
  Object.freeze({
    schema: 'public',
    table: 'rights_request',
    column: 'subject_customer_id',
    reason:
      'A merge may not re-point a request, and the refusal is structural rather than preferential: ' +
      '`rights_request_guard` (ZY002) freezes `subject_customer_id` along with the type, the instant it ' +
      'was received, the due instant and the verification method, because the DEADLINE is measured ' +
      'against those columns — a request answered on day forty becomes compliant the moment one of them ' +
      'can be edited. A request re-pointed at another person is also simply a different request, and the ' +
      'record of one outlives the record it was about (there is no foreign key here for the same reason). ' +
      'The read side resolves the tombstone: 0085’s three SECURITY DEFINER functions each authorise ' +
      'their customer id through `merge_survivor_of`, and the erasure engine walks the whole lineage, so ' +
      'a request naming the survivor covers every record merged into it.',
    registeredBy: 'C-CRM-10',
  }),
  Object.freeze({
    schema: 'public',
    table: 'legal_hold',
    column: 'subject_customer_id',
    reason:
      'The one entry here whose reason is about this registry’s own machinery. A hold MUST keep ' +
      'applying across a merge, so re-pointing looks right — but `legal_hold_one_live_per_scope` is a ' +
      'partial unique index over two `coalesce` EXPRESSIONS (null means "every subject" and null means ' +
      '"every data class", both of which are real values here rather than absent ones), and a ' +
      '`repoint_update`’s conflict test is a list of plain COLUMNS compared with `=`. Two live ' +
      'all-subject holds would therefore collide on the index while the skip that exists to prevent ' +
      'exactly that never fired, because `null = null` is unknown. So the tombstone is resolved on READ ' +
      'instead, and that is not a promise made here and kept nowhere: `apps/worker/src/jobs/' +
      'retention-purge.ts` wraps BOTH sides of the hold comparison in `merge_survivor_of` — the hold’s ' +
      'subject and the candidate row’s — so a hold placed before a merge still protects the ' +
      'survivor’s rows and a hold placed after it still protects rows captured under the loser’s ' +
      'id.',
    registeredBy: 'C-CRM-10',
  }),
  Object.freeze({
    schema: 'clinical',
    table: 'dek_destruction',
    column: 'customer_id',
    reason:
      'Unreachable from the application role (0009), append-only for every role including the owner ' +
      '(ZY005), and it must keep the id the destruction ACTUALLY happened under. It is the authority on ' +
      'whether a record was crypto-erased — the empty wrapped key is only the mechanism — and its rows ' +
      'name the customer id whose keys were destroyed at the time. Re-pointing them would make the ' +
      'record say a destruction happened for an id it did not, which is the one thing this table exists ' +
      'to be able to answer. Its siblings in this schema resolve the tombstone on read for the same ' +
      'reason, through the grant of `merge_survivor_of` to berelax_clinical.',
    registeredBy: 'C-CRM-10',
  }),
])

/**
 * The column names a merge has to account for, as a POSIX regex the catalogue query uses.
 *
 * `customer_id`, `contact_customer_id`, and anything ending `_customer_id` or `_contact_id`. Not
 * `customer_name_snapshot` and not `customer_phone`: those are values copied onto a document, and a
 * merge must not rewrite them (see the `invoice` allowlist entry).
 */
export const MERGE_ID_COLUMN_PATTERN = '^(.*_)?(customer|contact)_id$'

/**
 * Schemas the catalogue enumerates: every schema in the database except the system ones, pg-boss's and
 * Payload's.
 *
 * Discovered rather than listed, so a schema added later is covered by default. pg-boss's tables are
 * excluded by name because they are the queue library's own — a column in one of them is a job payload
 * rather than a customer record, and a strategy cannot be registered on a table this build does not own.
 *
 * ## Why `payload` is excluded, and how it was found
 *
 * The same sentence: this build does not own those tables. Payload creates them by pushing its own schema
 * when `getPayload()` first boots (ADR 0019 puts the CMS inside this application and this database), writes
 * to them only through its own API, and keeps a `_<collection>_v` version table beside each one. A direct
 * SQL UPDATE against a collection would desynchronise the versions and the drafts — so an erasure or a
 * merge could not act on this schema through a statement even if a row in it were a person's, which is a
 * substantive reason rather than a convenience.
 *
 * It was found by running the whole `pnpm verify` chain on ONE database, which is the only place the
 * omission is visible, and the reason it had been invisible is the ORDER rather than the rule. These tables
 * do not exist in a freshly migrated and seeded database at all: nothing in `packages/db/migrations`
 * creates them. `vitest.integration.config.ts` lists `packages/**` before `apps/**`, so
 * `packages/fixtures/src/rights.itest.ts` runs before the first `apps/web` suite boots Payload and the
 * probes returned nothing from here. By the time `pnpm gates:test` re-runs that same suite from gate block
 * 112, the schema exists and five columns appear — `payload.cms_user.email`,
 * `payload.cms_user.reset_password_token` and the `body` of `pages`, `journal_posts` and
 * `service_narrative`.
 *
 * Classifying those five in `rights-policy.ts` does not fix it and was tried first: `rights.itest.ts`
 * asserts `staleRuleKeys` is empty as well as `unclassified`, so a rule for a table that does not exist
 * fails in the other direction — and whether these tables exist depends on whether a process has booted
 * Payload. A catalogue that is a function of runtime cannot satisfy both halves at once. The exclusion is
 * what makes the enumeration stable, which is the property both halves rest on.
 *
 * What this does NOT claim: that CMS copy can never contain a person's details. It claims that a row-level
 * erasure cannot reach it through SQL, which is the same limitation ADR 0034 already records for free text
 * on a table that is not subject-scoped. The guard that keeps a named individual out of published copy is
 * the publication lint (B-CAT-05, W-SITE-07, W-SITE-10), and if that ever stops holding the fix is the
 * lint rather than an erasure rule that quietly redacts marketing.
 */
export const MERGE_CATALOGUE_EXCLUDED_SCHEMAS: readonly string[] = Object.freeze([
  'information_schema',
  PGBOSS_SCHEMA,
  /** Payload's own tables. See the header: not migration-created, and not writable by a statement. */
  'payload',
])

export interface MergeCoverageRow {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly status: 'participant' | 'allowlisted' | 'unregistered'
  readonly strategy: MergeStrategy | null
  readonly reason: string | null
}

/**
 * Every table in the application's schemas carrying a customer or contact id, classified.
 *
 * The enumeration is `information_schema` and not the registry, and that is the whole design: a test
 * that iterated {@link MERGE_PARTICIPANTS} could only ever report what somebody remembered to write
 * down, and the table nobody registered is exactly the one that ships with rows left behind.
 *
 * BASE TABLEs only. A view has no rows of its own — `public.customer_contraindication_flags` is one, and
 * re-pointing it would be meaningless — and the table underneath it is enumerated in its own right.
 */
export async function mergeCoverage(
  sql: Sql,
  participants: readonly MergeParticipant[] = MERGE_PARTICIPANTS,
  allowlist: readonly MergeAllowlistEntry[] = MERGE_ALLOWLIST,
): Promise<readonly MergeCoverageRow[]> {
  const rows = await sql<{ table_schema: string; table_name: string; column_name: string }[]>`
    select c.table_schema, c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where t.table_type = 'BASE TABLE'
       and c.table_schema not like 'pg\\_%'
       and c.table_schema <> all (${[...MERGE_CATALOGUE_EXCLUDED_SCHEMAS]}::text[])
       and c.column_name ~ ${MERGE_ID_COLUMN_PATTERN}
     order by c.table_schema, c.table_name, c.column_name
  `

  return rows.map((row) => {
    const registered = participants.find(
      (p) =>
        p.schema === row.table_schema && p.table === row.table_name && p.column === row.column_name,
    )
    if (registered !== undefined) {
      return {
        schema: row.table_schema,
        table: row.table_name,
        column: row.column_name,
        status: 'participant' as const,
        strategy: registered.strategy,
        reason: registered.why,
      }
    }
    const allowed = allowlist.find(
      (entry) =>
        entry.schema === row.table_schema &&
        entry.table === row.table_name &&
        entry.column === row.column_name,
    )
    return {
      schema: row.table_schema,
      table: row.table_name,
      column: row.column_name,
      status: allowed === undefined ? ('unregistered' as const) : ('allowlisted' as const),
      strategy: null,
      reason: allowed?.reason ?? null,
    }
  })
}

/** `schema.table`, which is how `merge_record_table.participant` spells a participant. */
export const participantName = (p: { readonly schema: string; readonly table: string }): string =>
  `${p.schema}.${p.table}`

/**
 * Refuses a participant whose identifiers are not identifiers, BEFORE anything is interpolated.
 *
 * The executor builds its statements with `sql.unsafe` — a dynamic table name, a dynamic column list and
 * a partial-index predicate cannot all be bound — so this is the boundary that makes that safe. It is a
 * function rather than a one-off assertion at module load because the participant set is an argument:
 * C-AUTO-03 will register a participant of its own, and a unit test drives the executor over an ad-hoc
 * one, so every path has to pass the same check.
 */
/** Every identifier a participant contributes to a statement, in one list so none escapes the check. */
function participantIdentifiers(p: MergeParticipant): readonly string[] {
  return [
    p.table,
    p.column,
    ...(p.conflictKey ?? []),
    ...(p.dedupeKey ?? []),
    ...(p.backReference?.groupBy ?? []),
    ...(p.backReference === null ? [] : [p.backReference.orderBy, p.backReference.stampColumn]),
    ...p.excludeColumns,
  ]
}

/** What each strategy needs in order to be executable at all. Separated for readability, not for reuse. */
function strategyProblems(p: MergeParticipant): readonly string[] {
  const problems: string[] = []
  if (!(MERGE_STRATEGIES as readonly string[]).includes(p.strategy)) {
    problems.push(`strategy "${p.strategy}" is not one of ${MERGE_STRATEGIES.join(', ')}`)
  }
  if (p.strategy === 'repoint_insert' && (p.dedupeKey === null || p.dedupeKey.length === 0)) {
    problems.push(
      'a repoint_insert participant needs a dedupeKey: without one, a second merge would copy the same ' +
        'rows again and the append-only table would hold each record twice',
    )
  }
  if (p.strategy === 'insert_backreference' && p.backReference === null) {
    problems.push('an insert_backreference participant needs a backReference')
  }
  if (p.strategy === 'union_dedupe' && (p.conflictKey === null || p.conflictKey.length === 0)) {
    problems.push(
      'a union_dedupe participant needs a conflictKey: the natural key IS the de-duplication, and ' +
        'without one the strategy would move every row and count one event twice',
    )
  }
  if ((p.conflictKey !== null || p.strategy === 'union_dedupe') && p.retainedReason === null) {
    problems.push(
      'a participant whose rows can be refused by a unique key needs a retainedReason: a row left on ' +
        'the tombstone with nothing saying why is the failure this registry exists to prevent',
    )
  }
  return problems
}

export function assertParticipantIsWellFormed(p: MergeParticipant): void {
  const problems: string[] = []
  for (const identifier of participantIdentifiers(p)) {
    if (!SQL_IDENTIFIER.test(identifier)) {
      problems.push(`"${identifier}" is not a bare lower-case SQL identifier`)
    }
  }
  if (p.schema !== 'public') {
    problems.push(
      `schema "${p.schema}" — a participant a merge WRITES to must be in public. The clinical schema is ` +
        'unreachable from the application role (0009) and belongs in MERGE_ALLOWLIST',
    )
  }
  if (p.activePredicate !== null && !SQL_PREDICATE.test(p.activePredicate)) {
    problems.push(
      `activePredicate "${p.activePredicate}" is not "<column> is null" or "<column> is not null"`,
    )
  }
  problems.push(...strategyProblems(p))
  if (problems.length > 0) {
    throw new AppError(
      'invariant_violated',
      `merge participant ${participantName(p)} is not well formed:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
      {
        details: {
          participant: participantName(p),
          problems,
          refusal: 'merge_participant_invalid',
        },
      },
    )
  }
}
