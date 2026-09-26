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
 * Every table a merge acts on, in the order it acts on them.
 *
 * `consent` is deliberately NOT last. The transaction test injects a failure immediately after the
 * consents are re-pointed, which is only a meaningful test if something comes after them — and the
 * ordering is also the one a reader wants: the profile tables, then the append-only records, then the
 * back-reference that depends on nothing.
 */
export const MERGE_PARTICIPANTS: readonly MergeParticipant[] = Object.freeze([
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
    table: 'flow_enrolment',
    column: 'customer_id',
    strategy: 'repoint_update',
    // No unique key involves the customer: the primary key is `id` and the two indexes on this table are
    // not unique, so no row can be refused and nothing can be retained.
    conflictKey: null,
    activePredicate: null,
    dedupeKey: null,
    backReference: null,
    excludeColumns: [],
    retainedReason: null,
    why:
      'An enrolment is a process attached to a contact (0070), so it must follow the person: left on the ' +
      'tombstone, a win-back sequence would go on sending to a record nothing else reads, resolving ' +
      'consent and suppression against a log the survivor no longer owns. Registered by C-CRM-06 rather ' +
      'than by C-CRM-05 because 0070 landed FIRST and nothing registered it: `mergeCoverage` enumerates ' +
      'from information_schema, so the completeness case in merge.itest.ts went red the moment the two ' +
      'branches met — which is exactly what that mechanism is for, and this is the first time it fired ' +
      'on a real table. What is still C-AUTO-07’s is the half its own acceptance names: `flow_run`, the ' +
      'step log and the (flow_run, node, channel, contact) idempotency keys do not exist yet, so a node ' +
      'already executed for the loser cannot be prevented from executing again for the survivor here. ' +
      'The pin (flow_id, definition_version) is immutable (ZF002) and is NOT touched: re-pointing the ' +
      'customer leaves the version this enrolment is governed by exactly where it was.',
    registeredBy: 'C-CRM-06',
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
 * Schemas the catalogue enumerates: every schema in the database except the system ones and pg-boss's.
 *
 * Discovered rather than listed, so a schema added later is covered by default. pg-boss's tables are
 * excluded by name because they are the queue library's own — a column in one of them is a job payload
 * rather than a customer record, and a strategy cannot be registered on a table this build does not own.
 */
export const MERGE_CATALOGUE_EXCLUDED_SCHEMAS: readonly string[] = Object.freeze([
  'information_schema',
  PGBOSS_SCHEMA,
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
