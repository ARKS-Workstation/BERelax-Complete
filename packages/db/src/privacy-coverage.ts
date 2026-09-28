import type { Sql } from './connection.ts'
import { MERGE_CATALOGUE_EXCLUDED_SCHEMAS, MERGE_ID_COLUMN_PATTERN } from './merge-participants.ts'

/**
 * The five catalogue probes that enumerate everywhere a data subject appears (C-CRM-10).
 *
 * This module holds NO list of tables. It holds five predicates over `information_schema` and
 * `pg_constraint`, and what they return is whatever the database actually has. The decisions live in
 * `packages/core/src/privacy/rights-policy.ts`, keyed by `schema.table.column`; a column this module
 * returns that nothing there classifies fails `packages/fixtures/src/rights.itest.ts`. A test that listed
 * the tables by hand would pass on the day somebody added the twenty-fifth one, which is the whole failure
 * mode of an erasure engine.
 *
 * ## Probe 1 is the merge registry's own probe, imported rather than restated
 *
 * {@link MERGE_ID_COLUMN_PATTERN} and {@link MERGE_CATALOGUE_EXCLUDED_SCHEMAS} come from
 * `merge-participants.ts`. That is deliberate and it is the point of this file: C-CRM-05 already answered
 * "which columns say whose a row is", and a second spelling of that pattern is how the merge and the
 * erasure come to disagree about one table. The constants are shared, so a widening of the merge's pattern
 * widens this unit's first probe on the same commit.
 *
 * ## Why one probe was not enough — and each of the other four earned its place
 *
 * Every one of these was added because running the query found something the previous probes had missed.
 * None of them was reasoned into existence:
 *
 *   2. **Contact details.** Found `otp_challenge` and `otp_phone_lock`, which are keyed by the PHONE NUMBER
 *      and hold no customer id at all, and `message.recipient`, which holds the address of every message
 *      ever sent with no customer id either. Three tables holding a person's phone number that probe 1
 *      cannot see. An erasure built on probe 1 alone would have reported success with the number still in
 *      the database three times over.
 *   3. **Foreign-key children.** Found `appointment`, `invoice_line`, `payment`, `package_balance` and the
 *      rest: tables whose only link to a subject is an FK to a covered table. Each needs a decision even
 *      when the decision is "it follows its parent", because that sentence is either checked or it is a
 *      thing somebody assumed.
 *   4. **Credentials.** Found exactly ONE table the other three miss, and it is the one that matters:
 *      `booking_manage_grant` holds a live token that lets its bearer view and cancel a booking, and it has
 *      no customer id, no contact detail and — checked against `pg_constraint`, not assumed — no foreign
 *      key to `booking`. Pseudonymising the customer does not make that link stop working.
 *   5. **Free-text notes.** Found `customer.notes`, which is where the front desk types a person's
 *      relationships, preferences and allergies in prose. It is not a reference, not a contact detail, not
 *      a credential and not a foreign key, so the first four probes are all blind to it.
 *
 * ## What this cannot find, stated because the alternative is implying otherwise
 *
 * A person's name typed into a free-text column on a table that is not subject-scoped — a cash-session
 * count note, an appointment reassignment's resolution note — is not reachable from a customer id by any
 * query, and no row-level erasure can find it. Probe 5 is narrowed to subject-scoped tables precisely so
 * that it makes a claim it can keep. The limitation is recorded in ADR 0034 and in
 * `rights_resolution.backup_position`'s sibling prose rather than left to be discovered.
 */

/**
 * Column names that hold a contact detail, a name, or a key derived from one.
 *
 * A list and not a pattern, because the pattern that catches these also catches
 * `credit_note_line.credit_note_id` and every `provisional_note` in the schema — forty-odd false
 * positives, and a probe with false positives is a probe whose classifications are mostly noise. Each name
 * here was taken from the catalogue and checked: `merge_record.phone_agreement` is in the list even though
 * it holds one of six comparison LABELS, because a reader of the probe should see that it was looked at.
 */
export const CONTACT_DETAIL_COLUMNS: readonly string[] = Object.freeze([
  'phone_e164',
  'phone_landline',
  'phone_mobile',
  'phone_whatsapp',
  'phone_match_key',
  'phone_agreement',
  'customer_phone',
  'issuer_phone',
  'recipient',
  'email',
  'google_email',
  'display_name',
  'public_display_name',
  'reviewer_display_name',
  'name_match_key',
  'customer_name_snapshot',
  'customer_address_snapshot',
  'issuer_address_snapshot',
  'issuer_address_snapshot_ar',
  'address_line_1',
  'address_line_2',
  'ip_address',
  'subject',
  'body',
  'body_html',
  /** A fact ABOUT a contact detail, so it goes stale with the detail it refers to. */
  'phone_verified_at',
  /** The customer's tax registration number, snapshotted onto a tax document. */
  'customer_trn',
  /**
   * `customer_blocklist.key_value`, and the reason it is named here is worth reading.
   *
   * It holds the NORMALISED PLAINTEXT — an E.164 number or a lower-cased address, behind 0053's own shape
   * checks — and not a hash. It was added to this list after the catalogue was read, because the merge
   * registry's entry for that table describes the match as being on the "hashed DETAIL", which is true of
   * `suppression.key_hmac` and not of this column. Without this name, the one table in the schema holding a
   * blocked person's phone number in the clear would not have been probed at all.
   */
  'key_value',
])

/**
 * Columns holding a token, a hash of one, or a secret. A POSIX regex, because unlike the contact names
 * these really do share a shape and the shape has no false positives in this schema.
 */
export const CREDENTIAL_COLUMN_PATTERN = '(^|_)(token|code_hash|sha256|hmac|secret)(_|$)'

/**
 * Free-text note columns. `notes`, or a name ending `_note`, and two spellings excluded BY NAME.
 *
 * `provisional_note` and `source_note` are the build's own provenance — they say why a seeded value is an
 * assumption and which OPEN-QUESTIONS id owns it (0026's convention). They appear on twenty-odd catalogue
 * and policy tables and they never hold anything about a person. Excluding them by name rather than by
 * narrowing the pattern keeps the exclusion visible: a reader can see which two were let through and why,
 * which is not true of a regex that quietly never matched them.
 */
export const FREE_TEXT_NOTE_PATTERN = '(^notes$|_note$)'
export const FREE_TEXT_NOTE_EXCLUSIONS: readonly string[] = Object.freeze([
  'provisional_note',
  'source_note',
])

export type ProbeAxis =
  | 'customer_reference'
  | 'contact_detail'
  | 'foreign_key_child'
  | 'credential'
  | 'free_text_note'

export interface ProbedColumnRow {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly axes: readonly ProbeAxis[]
}

interface RawProbeRow {
  readonly table_schema: string
  readonly table_name: string
  readonly column_name: string
  readonly axis: ProbeAxis
}

/**
 * Every column a data subject could be found through, from the catalogue, with which probe found it.
 *
 * One statement rather than five round trips, so the five probes cannot see five different databases —
 * they run against one snapshot inside one query. A column several probes find carries all of their names,
 * which is how `booking_session.phone_e164` reads as both a contact detail and (through its sibling
 * `customer_id`) part of a subject-scoped table.
 *
 * BASE TABLEs only, and the same schema exclusions the merge catalogue uses. A view has no rows of its own
 * and the table underneath it is enumerated in its own right.
 */
export async function erasureCoverage(sql: Sql): Promise<readonly ProbedColumnRow[]> {
  const rows = await sql<RawProbeRow[]>`
    with base as (
      -- **pg_catalog and NOT information_schema, and this is a privilege fix rather than a preference.**
      --
      -- information_schema is filtered to what the CURRENT ROLE holds a privilege on. 0009 revokes every
      -- privilege on the clinical schema from berelax_app, so an erasure run by the application — which
      -- is what the SECURITY DEFINER functions in 0085 exist to make possible — enumerated ZERO clinical
      -- columns and went on to report a complete, balanced, fully-accounted erasure over a catalogue that
      -- was missing five tables. That is this unit's defining failure arriving through privileges instead of
      -- through a forgotten rule, and no assertion made as the owner could ever see it: the suite connects
      -- as the owner, so the probe returned all 106 columns in every test.
      --
      -- pg_catalog is not privilege-filtered, so the probe now returns the SAME rows for every role, and
      -- rights.itest.ts asserts that equality directly by running the probe under berelax_app.
      -- pg_constraint was already unfiltered, which is why probe 3 alone was unaffected.
      select pn.nspname as table_schema, pc.relname as table_name, pa.attname as column_name,
             pt.typname as data_type
        from pg_class pc
        join pg_namespace pn on pn.oid = pc.relnamespace
        join pg_attribute pa on pa.attrelid = pc.oid and pa.attnum > 0 and not pa.attisdropped
        join pg_type pt on pt.oid = pa.atttypid
       -- r is an ordinary table and p a PARTITIONED one; both are what information_schema called a
       -- BASE TABLE, and audit_event is a p. A view has no rows of its own and the table underneath it
       -- is enumerated in its own right.
       where pc.relkind in ('r', 'p')
         -- PARTITIONS ARE NOT TABLES FOR THIS PURPOSE, and leaving them in was a live defect rather than
         -- untidiness. audit_event is partitioned monthly (0005) so that retention is a DETACH rather than
         -- a mass delete, and every partition is itself a table. Without this line the probe returned
         -- audit_event_2026_09.ip_address through audit_event_2026_12.ip_address, each needing its own
         -- rule — and the coverage test would then have gone RED on the first of every month, when the
         -- next partition appeared, on a branch nobody had touched. The parent is enumerated in its own
         -- right and the rule applies to the whole table.
         and not pc.relispartition
         and pn.nspname not like 'pg\\_%'
         and pn.nspname <> all (${[...MERGE_CATALOGUE_EXCLUDED_SCHEMAS]}::text[])
    ),    -- Probe 1: the merge registry's own axis, with the merge registry's own pattern.
    reference as (
      select table_schema, table_name, column_name
        from base where column_name ~ ${MERGE_ID_COLUMN_PATTERN}
    ),
    -- Every table that is ABOUT a data subject: one holding a reference, plus customer itself, which has
    -- no customer_id column because its own primary key is id — the gap that would otherwise make
    -- probe 5 blind to customer.notes, which is the column probe 5 exists for.
    subject_tables as (
      select distinct table_schema, table_name from reference
      union
      select 'public', 'customer'
    ),
    -- Probe 2.
    contact as (
      select table_schema, table_name, column_name
        from base
       where column_name = any (${[...CONTACT_DETAIL_COLUMNS]}::text[])
    ),
    -- Probe 3: a child whose only link to a subject is a foreign key to a subject-scoped table, and which
    -- none of the other probes already reached. not exists against the union rather than a NOT IN over a
    -- list, so a table gaining a reference column later leaves this probe automatically.
    fk_child as (
      select distinct n.nspname as table_schema, r.relname as table_name, a.attname as column_name
        from pg_constraint k
        join pg_class r      on r.oid = k.conrelid
        join pg_namespace n  on n.oid = r.relnamespace
        join pg_class fr     on fr.oid = k.confrelid
        join pg_namespace fn on fn.oid = fr.relnamespace
        join unnest(k.conkey) as ck(attnum) on true
        join pg_attribute a on a.attrelid = k.conrelid and a.attnum = ck.attnum
       where k.contype = 'f'
         and exists (
           select 1 from subject_tables st
            where st.table_schema = fn.nspname and st.table_name = fr.relname
         )
         and not exists (
           select 1 from subject_tables st
            where st.table_schema = n.nspname and st.table_name = r.relname
         )
         and not exists (
           select 1 from contact c
            where c.table_schema = n.nspname and c.table_name = r.relname
         )
    ),
    -- Probe 4.
    credential as (
      select table_schema, table_name, column_name
        from base where column_name ~ ${CREDENTIAL_COLUMN_PATTERN}
    ),
    -- Probe 5: free text on a subject-scoped table only, so the probe makes a claim it can keep.
    free_text as (
      select b.table_schema, b.table_name, b.column_name
        from base b
        join subject_tables st
          on st.table_schema = b.table_schema and st.table_name = b.table_name
       -- pg_type.typname spellings, not information_schema.data_type's: varchar rather than
       -- character varying, and bpchar rather than character. Getting this wrong would not error, it
       -- would silently match nothing — so the axis assertion in rights.itest.ts is what holds it shut.
       where b.data_type in ('text', 'varchar', 'bpchar')
         and b.column_name ~ ${FREE_TEXT_NOTE_PATTERN}
         and b.column_name <> all (${[...FREE_TEXT_NOTE_EXCLUSIONS]}::text[])
    ),
    probed as (
      select table_schema, table_name, column_name, 'customer_reference' as axis from reference
      union all
      select table_schema, table_name, column_name, 'contact_detail'     from contact
      union all
      select table_schema, table_name, column_name, 'foreign_key_child'  from fk_child
      union all
      select table_schema, table_name, column_name, 'credential'         from credential
      union all
      select table_schema, table_name, column_name, 'free_text_note'     from free_text
    )
    select table_schema, table_name, column_name, axis
      from probed
     group by table_schema, table_name, column_name, axis
     order by table_schema, table_name, column_name, axis
  `

  const byColumn = new Map<string, { row: RawProbeRow; axes: ProbeAxis[] }>()
  for (const row of rows) {
    const key = `${row.table_schema}.${row.table_name}.${row.column_name}`
    const existing = byColumn.get(key)
    if (existing === undefined) {
      byColumn.set(key, { row, axes: [row.axis] })
      continue
    }
    if (!existing.axes.includes(row.axis)) existing.axes.push(row.axis)
  }

  return Object.freeze(
    [...byColumn.values()].map(({ row, axes }) =>
      Object.freeze({
        schema: row.table_schema,
        table: row.table_name,
        column: row.column_name,
        axes: Object.freeze([...axes].sort()),
      }),
    ),
  )
}

/**
 * The tables an erasure must be able to account for, derived from the coverage.
 *
 * Returned as `schema.table` so it can be compared against the participants a resolution actually wrote a
 * `rights_resolution_class` row for — which is the other half of the accounting: the registry says what
 * SHOULD happen and this says what a run must have reported on.
 */
export function coveredTables(probed: readonly ProbedColumnRow[]): readonly string[] {
  return Object.freeze([...new Set(probed.map((p) => `${p.schema}.${p.table}`))].sort())
}
