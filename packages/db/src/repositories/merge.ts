import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import {
  assertParticipantIsWellFormed,
  MERGE_PARTICIPANTS,
  type MergeParticipant,
  type MergeStrategy,
  participantName,
} from '../merge-participants.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The merge, as one transaction (C-CRM-05), over the tables `merge-participants.ts` registers and the
 * record 0069 keeps of what it did.
 *
 * ## One transaction, and what that buys
 *
 * Everything below runs inside the caller's {@link UnitOfWork}, so the re-pointed rows, the copied
 * consent log, the suppression back-references, the `merge_record` and the `audit_event` are all durable
 * together or none of them are. A merge that committed half way is the worst state this area can be in:
 * the loser's consent log would have been copied onto the survivor while its bookings still hung off the
 * tombstone, and nothing would ever say so. `packages/fixtures/src/merge.itest.ts` injects a failure
 * immediately after the consents are re-pointed and asserts that not one consent row moved or was
 * copied, that no `merge_record` was written and that no audit row landed.
 *
 * ## The tombstone claim is taken FIRST
 *
 * `merge_record` is inserted before any row is moved, and the order is the point rather than a
 * convenience: `merge_record_one_merge_per_loser` is where two concurrent merges of one pair serialise —
 * the same argument 0063 makes for `checkout_finalisation_key_pk`. The second transaction blocks on the
 * index until the first commits, then fails the unique constraint having moved nothing, instead of
 * re-pointing rows the first has already re-pointed and copying an append-only log twice.
 *
 * The per-table counts go in afterwards, into `merge_record_table`, because they are not known until the
 * work is done — and their CHECKs are what refuse a report whose arithmetic does not balance.
 *
 * ## Why the statements are built rather than written
 *
 * Nine participants with four strategies is either one builder or nine hand-written statements, and nine
 * hand-written statements is how the tenth one gets forgotten — which is the failure the registry exists
 * to prevent. A dynamic table name, a dynamic column list and a partial-index predicate cannot all be
 * bound as parameters, so the builder uses `sql.unsafe` with every identifier checked against
 * {@link assertParticipantIsWellFormed} first and the two customer ids ALWAYS bound. Nothing in a
 * statement below comes from a request.
 *
 * ## What a merge deliberately does not do
 *
 * It deletes nothing. The loser's `customer` row keeps its number, its label and its notes, and the
 * rows a strategy could not move stay on it with a stated reason — `merge_record_table`'s constraints
 * refuse a report that does not account for every one of them. `mergeSurvivorOf` is how a reader gets
 * from a merged-away id to the live record, and 0069 grants the SQL function behind it to the clinical
 * role as well, because the clinical schema is unreachable from this package.
 */

export const MERGE_REFUSALS = [
  /** One record cannot be merged into itself. */
  'merge_same_record',
  /** One of the two ids is not a customer. */
  'merge_customer_not_found',
  /** The survivor was itself merged away. Resolve it first — the message names the live record. */
  'merge_survivor_is_a_tombstone',
  /** A registry entry is not well formed. Raised before any statement is issued. */
  'merge_participant_invalid',
  /**
   * A copying strategy finished with rows on the loser that have no counterpart on the survivor.
   *
   * THE refusal this unit exists for. An append-only table is re-pointed by copying, and a copy that
   * silently missed rows is invisible from every other direction: the merge succeeds, the survivor's log
   * looks plausible, and a withdrawal that was on the loser is simply not in it any more.
   */
  'merge_left_rows_behind',
  /**
   * A participant's key is not a unique index on its table, so "already there" means nothing.
   *
   * The other half of the same failure, and the half a row count cannot see. A dedupe key COARSER than
   * the real index makes the copy skip rows it should carry — the loser's withdrawal looks "already
   * there" because the survivor has some other row on the same channel — and a key FINER than the index
   * makes the copy attempt a row the index refuses. Both are silent from the row counts, so the key is
   * checked against `pg_index` before the statement runs rather than inferred from its result.
   */
  'merge_key_is_not_a_unique_index',
] as const
export type MergeRefusal = (typeof MERGE_REFUSALS)[number]

/** SQLSTATEs 0069 raises, so a caller can tell one refusal from another without reading prose. */
export const MERGE_SQLSTATE = {
  mergeRecordImmutable: 'ZT001',
  survivorIsATombstone: 'ZT002',
  chainTooLong: 'ZT003',
} as const

/** Audit actions this module writes. A named constant, so a test can count a delta on one. */
export const MERGE_AUDIT_ACTIONS = { merged: 'customer.merged' } as const

function refuse(
  refusal: MergeRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AppError(refusal === 'merge_customer_not_found' ? 'not_found' : 'conflict', message, {
    details: { ...details, refusal },
  })
}

/** The named refusal carried on an error this module raised, or null. */
export function mergeRefusalOf(err: unknown): MergeRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' && (MERGE_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as MergeRefusal)
    : null
}

// ------------------------------------------------------------------------------------------------
// The shapes the pure plan travels in
// ------------------------------------------------------------------------------------------------

/**
 * One record as `planCustomerMerge` in `@berelax/core` takes it.
 *
 * Declared here as well because `packages/db` may not import `packages/core` — the dependency runs the
 * other way. `packages/fixtures/src/merge.itest.ts` asserts the agreement with `satisfies` rather than
 * describing it in a comment, which is what `ConsentLogRead` does for `resolveConsent`.
 */
export interface CustomerMergeSubjectRead {
  readonly id: string
  /** Epoch milliseconds, which is what `Instant` is. A `Date` here would need a cast in core. */
  readonly createdAt: number
  readonly phoneE164: string
  readonly displayName: string | null
  readonly nameMatchKey: string | null
  readonly locale: string
  readonly notes: string | null
  readonly createdVia: string
  readonly phoneVerifiedAt: number | null
}

/** The plan `planCustomerMerge` returns, as this module needs it. Mirror, for the same reason. */
export interface CustomerMergePlanInput {
  readonly survivorId: string
  readonly loserId: string
  readonly authority: 'auto_merge' | 'operator_confirmed'
  readonly scorePerMille: number
  readonly phoneAgreement: string
  readonly labelAgreement: string
  readonly fields: readonly {
    readonly field: string
    readonly resolution: string
    readonly survivorValue: string | null
    readonly loserValue: string | null
    readonly why?: string
  }[]
  readonly survivorUpdates: {
    readonly displayName?: string
    readonly nameMatchKey?: string | null
    readonly notes?: string
  }
}

/** What one participant's merge did, as `merge_record_table` stores it. */
export interface MergeTableReport {
  readonly participant: string
  readonly idColumn: string
  readonly strategy: MergeStrategy
  readonly rowsBeforeSurvivor: number
  readonly rowsBeforeLoser: number
  readonly rowsAfterSurvivor: number
  readonly rowsAfterLoser: number
  readonly rowsMoved: number
  readonly rowsInserted: number
  readonly rowsRetainedOnLoser: number
  readonly retainedReason: string | null
}

export type MergeOutcome =
  | {
      readonly kind: 'merged'
      readonly mergeRecordId: string
      readonly survivorCustomerId: string
      readonly loserCustomerId: string
      readonly tables: readonly MergeTableReport[]
    }
  | {
      readonly kind: 'already_merged'
      readonly mergeRecordId: string
      readonly survivorCustomerId: string
      readonly loserCustomerId: string
      readonly mergedAtIso: string
    }

export interface MergeRecordRead {
  readonly id: string
  readonly survivorCustomerId: string
  readonly loserCustomerId: string
  readonly mergedAtIso: string
  readonly actorKind: string
  readonly actorLabel: string
  readonly authority: string
  readonly reason: string
  readonly scorePerMille: number
  readonly phoneAgreement: string
  readonly labelAgreement: string
  readonly fieldResolutions: readonly unknown[]
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

/** Two records, in the shape the pure plan takes. Null for an id that is not a customer. */
export async function readCustomerMergeSubject(
  sql: Sql,
  customerId: string,
): Promise<CustomerMergeSubjectRead | null> {
  const rows = await sql<
    {
      id: string
      created_at_ms: string
      phone_e164: string
      display_name: string | null
      name_match_key: string | null
      locale: string
      notes: string | null
      created_via: string
      phone_verified_at_ms: string | null
    }[]
  >`
    select id,
           (extract(epoch from created_at) * 1000)::bigint::text as created_at_ms,
           phone_e164, display_name, name_match_key, locale, notes, created_via,
           (extract(epoch from phone_verified_at) * 1000)::bigint::text as phone_verified_at_ms
      from customer where id = ${customerId}
  `
  const row = rows[0]
  if (row === undefined) return null
  return {
    id: row.id,
    createdAt: Number(row.created_at_ms),
    phoneE164: row.phone_e164,
    displayName: row.display_name,
    nameMatchKey: row.name_match_key,
    locale: row.locale,
    notes: row.notes,
    createdVia: row.created_via,
    phoneVerifiedAt: row.phone_verified_at_ms === null ? null : Number(row.phone_verified_at_ms),
  }
}

/**
 * The live record a customer id resolves to, following the chain to its end.
 *
 * Returns the id itself when it is not a tombstone, so a caller may wrap a read in it unconditionally.
 * The chain-walking is `merge_survivor_of(uuid)` in 0069 and not a query here, because the readers that
 * need it are not all in this package: 0009 revokes every privilege on the `clinical` schema from the
 * application role, so a clinical read resolving a merged-away customer has to do it in SQL.
 */
export async function mergeSurvivorOf(sql: Sql, customerId: string): Promise<string> {
  const [row] = await sql<{ survivor: string }[]>`
    select merge_survivor_of(${customerId}::uuid)::text as survivor
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'merge_survivor_of() returned no row. It is declared to return uuid for one uuid argument; no row ' +
        'means it is not the function 0069 created.',
    )
  }
  return row.survivor
}

/** The merge that made a record a tombstone, or null when it is not one. */
export async function readMergeRecordForLoser(
  sql: Sql,
  loserCustomerId: string,
): Promise<MergeRecordRead | null> {
  const rows = await sql<
    {
      id: string
      survivor_customer_id: string
      loser_customer_id: string
      merged_at: Date
      actor_kind: string
      actor_label: string
      authority: string
      reason: string
      score_per_mille: number
      phone_agreement: string
      label_agreement: string
      field_resolutions: unknown
    }[]
  >`
    select id, survivor_customer_id, loser_customer_id, merged_at, actor_kind, actor_label,
           authority, reason, score_per_mille, phone_agreement, label_agreement, field_resolutions
      from merge_record where loser_customer_id = ${loserCustomerId}
  `
  const row = rows[0]
  if (row === undefined) return null
  return {
    id: row.id,
    survivorCustomerId: row.survivor_customer_id,
    loserCustomerId: row.loser_customer_id,
    mergedAtIso: row.merged_at.toISOString(),
    actorKind: row.actor_kind,
    actorLabel: row.actor_label,
    authority: row.authority,
    reason: row.reason,
    scorePerMille: row.score_per_mille,
    phoneAgreement: row.phone_agreement,
    labelAgreement: row.label_agreement,
    fieldResolutions: Array.isArray(row.field_resolutions) ? row.field_resolutions : [],
  }
}

/** The per-table counts one merge recorded, in participant order. */
export async function readMergeTableReports(
  sql: Sql,
  mergeRecordId: string,
): Promise<readonly MergeTableReport[]> {
  const rows = await sql<
    {
      participant: string
      id_column: string
      strategy: MergeStrategy
      rows_before_survivor: number
      rows_before_loser: number
      rows_after_survivor: number
      rows_after_loser: number
      rows_moved: number
      rows_inserted: number
      rows_retained_on_loser: number
      retained_reason: string | null
    }[]
  >`
    select participant, id_column, strategy, rows_before_survivor, rows_before_loser,
           rows_after_survivor, rows_after_loser, rows_moved, rows_inserted,
           rows_retained_on_loser, retained_reason
      from merge_record_table where merge_record_id = ${mergeRecordId}
     order by participant
  `
  return rows.map((row) => ({
    participant: row.participant,
    idColumn: row.id_column,
    strategy: row.strategy,
    rowsBeforeSurvivor: row.rows_before_survivor,
    rowsBeforeLoser: row.rows_before_loser,
    rowsAfterSurvivor: row.rows_after_survivor,
    rowsAfterLoser: row.rows_after_loser,
    rowsMoved: row.rows_moved,
    rowsInserted: row.rows_inserted,
    rowsRetainedOnLoser: row.rows_retained_on_loser,
    retainedReason: row.retained_reason,
  }))
}

/**
 * How many rows each participant holds for one customer.
 *
 * Exported because "zero hard deletes occurred" is only assertable as a pair of counts taken around the
 * merge, and a test that wrote its own nine queries would be asserting about its own list rather than
 * about the registry.
 */
export async function mergeRowCounts(
  sql: Sql,
  customerId: string,
  participants: readonly MergeParticipant[] = MERGE_PARTICIPANTS,
): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>()
  for (const p of participants) {
    assertParticipantIsWellFormed(p)
    counts.set(participantName(p), await countFor(sql, p, customerId))
  }
  return counts
}

// ------------------------------------------------------------------------------------------------
// The statement builder
// ------------------------------------------------------------------------------------------------

/**
 * A row-wise `is not distinct from` over a list of columns, aliased on both sides.
 *
 * `is not distinct from` and not `=`, because `waitlist_one_row_per_window` is declared NULLS NOT
 * DISTINCT: its `therapist_id` is null for "any therapist", and under `=` two such rows would compare
 * NULL, the conflict test would pass, and the re-point would then be refused by the index it was
 * supposed to have anticipated. The same operator is what 0065 uses for its pair tests and for the same
 * class of reason.
 */
const rowsAgree = (columns: readonly string[], left: string, right: string): string =>
  `(${columns.map((c) => `${left}.${c}`).join(', ')}) is not distinct from ` +
  `(${columns.map((c) => `${right}.${c}`).join(', ')})`

/** `activePredicate` with its alias applied: `lifted_at is null` becomes `t.lifted_at is null`. */
const aliased = (predicate: string, alias: string): string => `${alias}.${predicate}`

async function countFor(sql: Sql, p: MergeParticipant, customerId: string): Promise<number> {
  const rows = await sql.unsafe<{ n: string }[]>(
    `select count(*)::text as n from ${p.schema}.${p.table} where ${p.column} = $1`,
    [customerId],
  )
  return Number(rows[0]?.n ?? '0')
}

/** Every column of a participant except the ones a copy must not carry. */
async function copyColumns(sql: Sql, p: MergeParticipant): Promise<readonly string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
     where table_schema = ${p.schema} and table_name = ${p.table}
     order by ordinal_position
  `
  const excluded = new Set(p.excludeColumns)
  const columns = rows.map((row) => row.column_name).filter((name) => !excluded.has(name))
  if (columns.length === 0) {
    throw new AppError(
      'invariant_violated',
      `${participantName(p)} has no copyable columns, so information_schema returned nothing for it. ` +
        'A copying strategy over zero columns would insert empty rows.',
    )
  }
  // Derived from the catalogue rather than listed in the registry deliberately: a column added to
  // `consent` by a later migration is copied by a merge without anybody remembering to add it here,
  // which is the same reason the participant set itself is checked against the catalogue.
  for (const column of columns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
      throw new AppError(
        'invariant_violated',
        `${participantName(p)} has a column named "${column}", which is not a bare identifier and ` +
          'cannot be interpolated into a copy statement.',
      )
    }
  }
  return columns
}

/**
 * `update … set <column> = survivor where <column> = loser`, skipping what the unique key would refuse.
 *
 * The NOT EXISTS carries the partial-index predicate on BOTH sides, and on the row being moved as well
 * as on the candidate it might collide with. That is not symmetry for its own sake: a LIFTED
 * do-not-pair row is outside `customer_therapist_do_not_pair_one_active`, so it cannot collide with
 * anything and must move — and with the predicate applied only to the candidate it would have been held
 * back by a live row it was never in conflict with.
 */
function repointUpdateStatement(p: MergeParticipant): string {
  const relation = `${p.schema}.${p.table}`
  const guards: string[] = [`s.${p.column} = $2`]
  if (p.activePredicate !== null) {
    guards.push(aliased(p.activePredicate, 's'), aliased(p.activePredicate, 't'))
  }
  if (p.conflictKey !== null && p.conflictKey.length > 0) {
    guards.push(rowsAgree(p.conflictKey, 's', 't'))
  }
  const conflict =
    p.conflictKey === null
      ? ''
      : ` and not exists (select 1 from ${relation} s where ${guards.join(' and ')})`
  return (
    `with moved as (\n` +
    `  update ${relation} t set ${p.column} = $2\n` +
    `   where t.${p.column} = $1${conflict}\n` +
    `  returning 1\n` +
    `)\n` +
    `select count(*)::text as n from moved`
  )
}

/**
 * The copy an append-only table is re-pointed by, and the query that proves it missed nothing.
 *
 * No `on conflict do nothing`, deliberately. Inside one transaction the NOT EXISTS has already excluded
 * every row the unique index would refuse, so a conflict here means the dedupe key does not describe
 * that index — and swallowing it would leave exactly the rows this strategy exists to carry across
 * sitting on the tombstone, with a merge that reported success.
 */
function repointInsertStatement(p: MergeParticipant, columns: readonly string[]): string {
  const relation = `${p.schema}.${p.table}`
  const dedupe = p.dedupeKey ?? []
  const selected = columns.map((column) => (column === p.column ? '$2' : `l.${column}`))
  return (
    `with copied as (\n` +
    `  insert into ${relation} (${columns.join(', ')})\n` +
    `  select ${selected.join(', ')}\n` +
    `    from ${relation} l\n` +
    `   where l.${p.column} = $1\n` +
    `     and not exists (select 1 from ${relation} s\n` +
    `                      where s.${p.column} = $2 and ${rowsAgree(dedupe, 's', 'l')})\n` +
    `  returning 1\n` +
    `)\n` +
    `select count(*)::text as n from copied`
  )
}

/** Loser rows with no counterpart on the survivor. Zero, or the copy left rows behind. */
function orphanedAfterCopyStatement(p: MergeParticipant): string {
  const relation = `${p.schema}.${p.table}`
  const dedupe = p.dedupeKey ?? []
  return (
    `select count(*)::text as n from ${relation} l\n` +
    ` where l.${p.column} = $1\n` +
    `   and not exists (select 1 from ${relation} s\n` +
    `                    where s.${p.column} = $2 and ${rowsAgree(dedupe, 's', 'l')})`
  )
}

/**
 * The newest entry per group, as a CTE named `newest`, for every group the loser's rows touch.
 *
 * `rank()` and not `row_number()`, and it is the whole of what makes a back-reference state-preserving.
 * Two entries for one detail may share the newest instant — a suppression and a lift recorded together,
 * which 0064 says the resolver deliberately fails closed on — and `rank()` takes BOTH, so the copy
 * reproduces the tie and the resolved state is unchanged. `row_number()` would take one of them and
 * settle an ambiguity by accident, and half the time the one it settled on reads as "not suppressed".
 *
 * One definition, used by the copy and by the check that the copy left nothing unreferenced: two copies
 * of this text is how the two come to disagree about which row is newest.
 */
function newestPerGroupCte(
  p: MergeParticipant,
  back: NonNullable<MergeParticipant['backReference']>,
): string {
  const relation = `${p.schema}.${p.table}`
  return (
    `with newest as (\n` +
    `  select * from (\n` +
    `    select t.*, rank() over (partition by ${back.groupBy.join(', ')} ` +
    `order by t.${back.orderBy} desc) as merge_rk\n` +
    `      from ${relation} t\n` +
    `     where exists (select 1 from ${relation} m\n` +
    `                    where m.${p.column} = $1 and ${rowsAgree(back.groupBy, 'm', 't')})\n` +
    `  ) ranked where merge_rk = 1\n` +
    `)`
  )
}

const backReferenceOf = (p: MergeParticipant): NonNullable<MergeParticipant['backReference']> => {
  const back = p.backReference
  if (back === null) {
    throw new AppError(
      'invariant_violated',
      `${participantName(p)} is registered insert_backreference with no backReference.`,
    )
  }
  return back
}

/**
 * The back-reference a table keyed on a hashed detail is owed, and nothing else.
 *
 * One row per detail the loser's entries name, restating that detail's NEWEST entry (see
 * {@link newestPerGroupCte} for why that may be more than one row) with the survivor's id and the merge
 * instant. Two further things about it are deliberate:
 *
 *   - **A detail already attributed to the survivor is skipped**, tested over the whole newest set rather
 *     than row by row, so a tie is never split across two instants.
 *   - **The stamp column is set to the merge instant**, because the table's unique key includes it: the
 *     restatement is a new record of the same decision, by the same actor, with the same reason.
 */
function backReferenceStatement(p: MergeParticipant, columns: readonly string[]): string {
  const relation = `${p.schema}.${p.table}`
  const back = backReferenceOf(p)
  const selected = columns.map((column) => {
    if (column === p.column) return '$2'
    if (column === back.stampColumn) return '$3'
    return `o.${column}`
  })
  return (
    `${newestPerGroupCte(p, back)},\n` +
    `owed as (\n` +
    `  select n.* from newest n\n` +
    `   where not exists (select 1 from newest h\n` +
    `                      where h.${p.column} = $2 and ${rowsAgree(back.groupBy, 'h', 'n')})\n` +
    `),\n` +
    `copied as (\n` +
    `  insert into ${relation} (${columns.join(', ')})\n` +
    `  select ${selected.join(', ')} from owed o\n` +
    `  returning 1\n` +
    `)\n` +
    `select count(*)::text as n from copied`
  )
}

/** Details the loser's entries name whose newest entry still does not name the survivor. Must be zero. */
function unreferencedDetailsStatement(p: MergeParticipant): string {
  const back = backReferenceOf(p)
  const group = back.groupBy.join(', ')
  return (
    `${newestPerGroupCte(p, back)}\n` +
    `select count(*)::text as n from (\n` +
    `  select ${group} from newest\n` +
    `   group by ${group}\n` +
    `  having count(*) filter (where ${p.column} = $2) = 0\n` +
    `) unreferenced`
  )
}

/**
 * Refuses a participant whose key is not a unique index on its own table.
 *
 * Read against `pg_index` rather than declared, because the point is to catch the registry and the
 * database DISAGREEING — which is what happens when a later migration changes an index and nobody
 * revisits the participant. A dedupe key is a claim about which rows are the same row, and a claim that
 * no index backs is one the database will not enforce and this code cannot verify from a count.
 *
 * Expression indexes drop out of the column list and therefore never match, which is the safe direction:
 * a participant keyed on an expression would be refused rather than trusted.
 */
export async function assertParticipantKeyIsAUniqueIndex(
  sql: Sql,
  p: MergeParticipant,
): Promise<void> {
  const key = p.dedupeKey ?? p.conflictKey
  if (key === null) return
  const wanted = [...new Set([p.column, ...key])].sort()
  const rows = await sql<{ index_name: string; columns: string[] }[]>`
    select i.relname as index_name,
           array_agg(a.attname order by a.attname) as columns
      from pg_index ix
      join pg_class i on i.oid = ix.indexrelid
      join pg_class t on t.oid = ix.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      join unnest(ix.indkey) with ordinality as k(attnum, ord) on true
      join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
     where n.nspname = ${p.schema} and t.relname = ${p.table} and ix.indisunique
     group by i.relname
  `
  const matched = rows.find((row) => [...row.columns].sort().join(',') === wanted.join(','))
  if (matched === undefined) {
    refuse(
      'merge_key_is_not_a_unique_index',
      `${participantName(p)} is registered with the key (${wanted.join(', ')}), and no unique index on ` +
        'that table has exactly those columns. A key no index backs cannot say which rows are the same ' +
        'row: coarser than the index and the copy skips rows it should carry, finer and the copy attempts ' +
        `a row the index refuses. Indexes found: ${
          rows.length === 0
            ? 'none'
            : rows.map((row) => `${row.index_name}(${row.columns.join(',')})`).join('; ')
        }.`,
      { participant: participantName(p), wanted, found: rows.map((row) => row.index_name) },
    )
  }
}

async function scalar(
  sql: Sql,
  statement: string,
  params: readonly (string | null)[],
): Promise<number> {
  const rows = await sql.unsafe<{ n: string }[]>(statement, [...params])
  return Number(rows[0]?.n ?? '0')
}

/**
 * Applies one participant and returns what it did.
 *
 * Every count is taken from the database on both sides of the work rather than derived from the
 * statement's own return value. That is what makes `merge_record_table`'s balance constraints a check on
 * the merge instead of a check on its arithmetic: a statement that moved more rows than it reported, or
 * that a trigger rewrote, fails the constraint and rolls the merge back.
 */
export async function applyMergeParticipant(
  sql: Sql,
  p: MergeParticipant,
  args: {
    readonly survivorCustomerId: string
    readonly loserCustomerId: string
    readonly mergedAtIso: string
  },
): Promise<MergeTableReport> {
  assertParticipantIsWellFormed(p)
  await assertParticipantKeyIsAUniqueIndex(sql, p)
  const { survivorCustomerId: survivor, loserCustomerId: loser } = args

  const rowsBeforeSurvivor = await countFor(sql, p, survivor)
  const rowsBeforeLoser = await countFor(sql, p, loser)

  let rowsMoved = 0
  let rowsInserted = 0

  if (p.strategy === 'repoint_update' || p.strategy === 'union_dedupe') {
    rowsMoved = await scalar(sql, repointUpdateStatement(p), [loser, survivor])
  } else if (p.strategy === 'repoint_insert') {
    const columns = await copyColumns(sql, p)
    rowsInserted = await scalar(sql, repointInsertStatement(p, columns), [loser, survivor])
    const orphaned = await scalar(sql, orphanedAfterCopyStatement(p), [loser, survivor])
    if (orphaned > 0) {
      refuse(
        'merge_left_rows_behind',
        `${participantName(p)} left ${orphaned} row(s) on customer ${loser} with no counterpart on ` +
          `${survivor} after the copy. The table is append-only, so a row that was not copied is a row ` +
          'the survivor does not have — and for a consent log that means a withdrawal the send path can ' +
          'no longer see. The merge is refused rather than reported as done.',
        { participant: participantName(p), orphaned, survivor, loser },
      )
    }
  } else {
    const columns = await copyColumns(sql, p)
    rowsInserted = await scalar(sql, backReferenceStatement(p, columns), [
      loser,
      survivor,
      args.mergedAtIso,
    ])
    const unreferenced = await scalar(sql, unreferencedDetailsStatement(p), [loser, survivor])
    if (unreferenced > 0) {
      refuse(
        'merge_left_rows_behind',
        `${participantName(p)} left ${unreferenced} detail(s) named by customer ${loser} without a ` +
          `back-reference to ${survivor}. The list itself still refuses those details — it keys on the ` +
          'hash and not on the contact — but a report of who opted out would no longer name the ' +
          'surviving record, which is the one thing a merge owes this table.',
        { participant: participantName(p), unreferenced, survivor, loser },
      )
    }
  }

  const rowsAfterSurvivor = await countFor(sql, p, survivor)
  const rowsAfterLoser = await countFor(sql, p, loser)
  // Only a strategy that MOVES can leave a row behind; a copy leaves every original where it was by
  // definition, and 0069's `merge_record_table_a_copied_row_did_not_move` refuses the alternative.
  const rowsRetainedOnLoser =
    p.strategy === 'repoint_update' || p.strategy === 'union_dedupe' ? rowsAfterLoser : 0

  return {
    participant: participantName(p),
    idColumn: p.column,
    strategy: p.strategy,
    rowsBeforeSurvivor,
    rowsBeforeLoser,
    rowsAfterSurvivor,
    rowsAfterLoser,
    rowsMoved,
    rowsInserted,
    rowsRetainedOnLoser,
    retainedReason: rowsRetainedOnLoser > 0 ? p.retainedReason : null,
  }
}

// ------------------------------------------------------------------------------------------------
// The merge
// ------------------------------------------------------------------------------------------------

export interface MergeCustomersArgs {
  readonly plan: CustomerMergePlanInput
  /** When the merge was decided. Supplied, never `now()`: every assertion here uses a frozen clock. */
  readonly mergedAtIso: string
  readonly reason: string
  /**
   * Who decided. Named rather than inherited from the unit of work's actor, because 0069 closes the set
   * to `staff` and `system` while an `AuditWriter` actor may also be a customer or an agent — and a
   * merge is a decision about somebody's records that they cannot take themselves.
   */
  readonly actorKind: 'staff' | 'system'
  readonly actorLabel: string
}

/**
 * Merges one customer record into another, in the caller's transaction.
 *
 * The participant set is an argument so that later units can register into it (C-AUTO-03's frequency
 * ledger and C-AUTO-07's flow runs both will) and so that a suite can drive one strategy over one table.
 * It is not a way to narrow a production merge: `mergeCoverage` is what proves the default set covers
 * every table the database actually has, and `merge.itest.ts` asserts a real merge records one
 * `merge_record_table` row for every registered participant.
 */
export async function mergeCustomers(
  uow: UnitOfWork,
  args: MergeCustomersArgs,
  participants: readonly MergeParticipant[] = MERGE_PARTICIPANTS,
): Promise<MergeOutcome> {
  const { plan } = args
  // Every identifier, before anything is issued. A registry entry that is not well formed must not
  // reach `sql.unsafe`, and a merge that had already moved rows before noticing would be worse.
  for (const p of participants) assertParticipantIsWellFormed(p)

  if (plan.survivorId === plan.loserId) {
    refuse(
      'merge_same_record',
      `Customer ${plan.survivorId} cannot be merged into itself: every row count would be doubled by ` +
        'the same row and nothing would move.',
      { customerId: plan.survivorId },
    )
  }

  // Idempotency, and it is a READ of the tombstone rather than a caught unique violation. A repeated
  // merge is what an at-least-once queue and a double-clicked button both produce, and the acceptance
  // is that it mutates nothing — so nothing is written on this path at all, not even an audit row: a
  // trail that grew a row per redelivery would bury the one real merge in retries of it.
  const existing = await readMergeRecordForLoser(uow.sql, plan.loserId)
  if (existing !== null) {
    return {
      kind: 'already_merged',
      mergeRecordId: existing.id,
      survivorCustomerId: existing.survivorCustomerId,
      loserCustomerId: existing.loserCustomerId,
      mergedAtIso: existing.mergedAtIso,
    }
  }

  // 0069's trigger refuses this too (ZT002). Checked here as well so the caller gets a typed refusal
  // naming the live record instead of a SQLSTATE it would have to translate.
  const survivorNow = await mergeSurvivorOf(uow.sql, plan.survivorId)
  if (survivorNow !== plan.survivorId) {
    refuse(
      'merge_survivor_is_a_tombstone',
      `Customer ${plan.survivorId} was itself merged into ${survivorNow}, so it cannot be the survivor ` +
        'of another merge. Merge into that record instead — a merge pointing at a tombstone would move ' +
        'rows onto a record nothing reads.',
      { survivorId: plan.survivorId, resolvesTo: survivorNow },
    )
  }

  const survivor = await readCustomerMergeSubject(uow.sql, plan.survivorId)
  const loser = await readCustomerMergeSubject(uow.sql, plan.loserId)
  for (const [id, row] of [
    [plan.survivorId, survivor],
    [plan.loserId, loser],
  ] as const) {
    if (row === null) {
      refuse('merge_customer_not_found', `Customer ${id} does not exist, so it cannot be merged.`, {
        customerId: id,
      })
    }
  }

  // The tombstone claim FIRST: this is where two concurrent merges of one pair serialise. See the
  // module header — the second transaction blocks on `merge_record_one_merge_per_loser` and then fails
  // it having moved nothing, rather than copying an append-only log a second time.
  const [record] = await uow.sql<{ id: string }[]>`
    insert into merge_record (
      survivor_customer_id, loser_customer_id, merged_at, actor_kind, actor_label, authority, reason,
      score_per_mille, phone_agreement, label_agreement, field_resolutions
    ) values (
      ${plan.survivorId}::uuid, ${plan.loserId}::uuid, ${args.mergedAtIso}::timestamptz,
      ${args.actorKind}, ${args.actorLabel}, ${plan.authority}, ${args.reason},
      ${plan.scorePerMille}, ${plan.phoneAgreement}, ${plan.labelAgreement},
      ${uow.sql.json([...plan.fields] as never)}
    )
    returning id
  `
  if (record === undefined) {
    throw new AppError(
      'invariant_violated',
      'The merge_record insert returned no row. It has no ON CONFLICT clause, so a silent no-op is not ' +
        'a state it can be in.',
    )
  }

  // The survivor gains what it had none of, and nothing it already had is overwritten — `ensureCustomer`
  // states the rule and this must not restate it differently: the front desk correcting a spelling must
  // not be undone by a merge, and a name written without its match key is a record the duplicate scan
  // can no longer find (0019 writes that key from the application).
  const updates = plan.survivorUpdates
  if (updates.displayName !== undefined) {
    await uow.sql`
      update customer
         set display_name = ${updates.displayName}, name_match_key = ${updates.nameMatchKey ?? null}
       where id = ${plan.survivorId} and display_name is null
    `
  }
  if (updates.notes !== undefined) {
    await uow.sql`
      update customer set notes = ${updates.notes} where id = ${plan.survivorId} and notes is null
    `
  }

  const tables: MergeTableReport[] = []
  for (const p of participants) {
    tables.push(
      await applyMergeParticipant(uow.sql, p, {
        survivorCustomerId: plan.survivorId,
        loserCustomerId: plan.loserId,
        mergedAtIso: args.mergedAtIso,
      }),
    )
  }

  for (const report of tables) {
    await uow.sql`
      insert into merge_record_table (
        merge_record_id, participant, id_column, strategy, rows_before_survivor, rows_before_loser,
        rows_after_survivor, rows_after_loser, rows_moved, rows_inserted, rows_retained_on_loser,
        retained_reason
      ) values (
        ${record.id}::uuid, ${report.participant}, ${report.idColumn}, ${report.strategy},
        ${report.rowsBeforeSurvivor}, ${report.rowsBeforeLoser}, ${report.rowsAfterSurvivor},
        ${report.rowsAfterLoser}, ${report.rowsMoved}, ${report.rowsInserted},
        ${report.rowsRetainedOnLoser}, ${report.retainedReason}
      )
    `
  }

  await uow.audit.record({
    action: MERGE_AUDIT_ACTIONS.merged,
    entityType: 'customer',
    entityId: plan.loserId,
    operation: 'update',
    before: { customer_id: plan.loserId, phone_e164: loser?.phoneE164 ?? null },
    after: {
      merge_record_id: record.id,
      survivor_customer_id: plan.survivorId,
      authority: plan.authority,
      score_per_mille: plan.scorePerMille,
      rows_moved: tables.reduce((total, report) => total + report.rowsMoved, 0),
      rows_inserted: tables.reduce((total, report) => total + report.rowsInserted, 0),
      rows_retained_on_loser: tables.reduce(
        (total, report) => total + report.rowsRetainedOnLoser,
        0,
      ),
    },
  })

  return {
    kind: 'merged',
    mergeRecordId: record.id,
    survivorCustomerId: plan.survivorId,
    loserCustomerId: plan.loserId,
    tables,
  }
}
