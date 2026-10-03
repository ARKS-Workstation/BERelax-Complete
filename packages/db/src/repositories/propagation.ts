import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * `publish_propagation`, the visible outbox of the publish loop (migration 0158).
 *
 * One row per propagation run, written once and updated once as the two outbound calls complete. The
 * fakes keep their own in-memory outboxes and those are the right shape for a fake; this is the one an
 * operator selects from, which is what the acceptance criterion's *"the fake writes every call to the
 * visible outbox"* has to mean once a process can restart.
 *
 * ## Why `recordPropagation` is an upsert that READS rather than one that overwrites
 *
 * `publish_propagation_once_per_set` is unique on `(surface, idempotency_key)`, and the key is a hash of
 * the changed URL set. So a retried publish conflicts — and what the caller needs then is not "the write
 * succeeded" but **the row that already exists**, because the decision it has to make is whether to send
 * anything at all. `on conflict do update` returning the row would have been the obvious spelling and is
 * wrong twice: it would bump `updated_at` on a run nobody repeated, and ZY791 refuses a URL-set rewrite
 * on a row whose submission was accepted — so the honest answer is `do nothing` plus a read.
 */

/** What was published. The vocabulary `publish_propagation_surface_known` enforces. */
export type PropagationSurface =
  | 'service'
  | 'therapist'
  | 'content'
  | 'premises'
  | 'theme'
  | 'media'
  | 'package'

/** How one outbound call ended. The two ports' vocabularies, as the CHECK spells them. */
export type PropagationOutcome =
  | 'accepted'
  | 'deduplicated'
  | 'rejected'
  /** IndexNow only: the key is a marker, so there was nothing to submit with (`Y1-indexnow-key`). */
  | 'refused_no_key'
  | 'not_attempted'

export interface PropagationRecord {
  readonly id: string
  readonly surface: PropagationSurface
  readonly subjectId: string | null
  readonly idempotencyKey: string
  readonly changedUrls: readonly string[]
  readonly indexnowOutcome: PropagationOutcome
  readonly indexnowError: string | null
  readonly purgeOutcome: PropagationOutcome
  readonly purgeError: string | null
  readonly cacheTags: readonly string[]
  readonly createdAt: string
  /** True when this run found an existing row for its URL set and sent nothing. */
  readonly alreadyRecorded: boolean
}

export interface RecordPropagationInput {
  readonly surface: PropagationSurface
  readonly subjectId: string | null
  readonly idempotencyKey: string
  readonly changedUrls: readonly string[]
  readonly indexnowOutcome: PropagationOutcome
  readonly indexnowError: string | null
  readonly purgeOutcome: PropagationOutcome
  readonly purgeError: string | null
  readonly cacheTags: readonly string[]
}

interface PropagationRow {
  readonly id: string
  readonly surface: string
  readonly subject_id: string | null
  readonly idempotency_key: string
  readonly changed_urls: string[]
  readonly indexnow_outcome: string
  readonly indexnow_error: string | null
  readonly purge_outcome: string
  readonly purge_error: string | null
  readonly cache_tags: string[]
  readonly created_at: Date
}

const COLUMNS =
  'id, surface, subject_id, idempotency_key, changed_urls, indexnow_outcome, indexnow_error, ' +
  'purge_outcome, purge_error, cache_tags, created_at'

function toRecord(row: PropagationRow, alreadyRecorded: boolean): PropagationRecord {
  return {
    id: row.id,
    surface: row.surface as PropagationSurface,
    subjectId: row.subject_id,
    idempotencyKey: row.idempotency_key,
    changedUrls: row.changed_urls,
    indexnowOutcome: row.indexnow_outcome as PropagationOutcome,
    indexnowError: row.indexnow_error,
    purgeOutcome: row.purge_outcome as PropagationOutcome,
    purgeError: row.purge_error,
    cacheTags: row.cache_tags,
    createdAt: new Date(row.created_at).toISOString(),
    alreadyRecorded,
  }
}

/**
 * Record one propagation run, or return the one that already covers this URL set.
 *
 * `alreadyRecorded` is the answer the caller acts on. It is on the RECORD rather than returned beside it
 * because every consumer wants both — the job logs the outcome and the console shows the row — and a
 * separate boolean is the one a caller drops.
 */
export async function recordPropagation(
  sql: Sql,
  input: RecordPropagationInput,
): Promise<PropagationRecord> {
  if (input.changedUrls.length === 0) {
    // Refused here as well as by `publish_propagation_changed_something`, because the caller can say
    // something the constraint cannot: a propagation with no URLs is a job that should not have run, and
    // the message names the surface rather than the constraint.
    throw new AppError(
      'validation',
      `a ${input.surface} propagation changed no URLs, so there is nothing to ping, purge or record. A ` +
        'run with an empty set is a publish that moved nothing — the caller decides not to run, rather ' +
        'than recording that it did.',
      { details: { rule: 'propagation_changed_something', surface: input.surface } },
    )
  }
  const inserted = await sql<PropagationRow[]>`
    insert into publish_propagation
      (surface, subject_id, idempotency_key, changed_urls, indexnow_outcome, indexnow_error,
       purge_outcome, purge_error, cache_tags)
    values (${input.surface}, ${input.subjectId}, ${input.idempotencyKey},
            ${[...input.changedUrls]}::text[], ${input.indexnowOutcome}, ${input.indexnowError},
            ${input.purgeOutcome}, ${input.purgeError}, ${[...input.cacheTags]}::text[])
    on conflict (surface, idempotency_key) do nothing
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = inserted[0]
  if (row !== undefined) return toRecord(row, false)
  const [existing] = await sql<PropagationRow[]>`
    select ${sql.unsafe(COLUMNS)} from publish_propagation
     where surface = ${input.surface} and idempotency_key = ${input.idempotencyKey}
  `
  if (existing === undefined) {
    throw new AppError(
      'invariant_violated',
      'the propagation insert conflicted and the row it conflicted with cannot be read. Nothing else ' +
        'deletes from this table, so the two statements disagreeing means the unique index is not the ' +
        'one the insert named.',
      { details: { rule: 'propagation_conflict_has_a_row' } },
    )
  }
  return toRecord(existing, true)
}

/** The most recent propagations, newest first — what the agent console lists. */
export async function readPropagations(
  sql: Sql,
  limit = 50,
): Promise<readonly PropagationRecord[]> {
  const rows = await sql<PropagationRow[]>`
    select ${sql.unsafe(COLUMNS)} from publish_propagation
     order by created_at desc, id desc limit ${limit}
  `
  // `alreadyRecorded: false` for a read: the flag is a property of the WRITE that produced the row, not
  // of the row. A reader that needed it would be asking the wrong question — how many times a set was
  // published is the count of audit rows, not a boolean here.
  return rows.map((row) => toRecord(row, false))
}
