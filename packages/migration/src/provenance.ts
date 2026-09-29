import { createHash } from 'node:crypto'
import type { Sql, UnitOfWork } from '@berelax/db'
import { AppError } from '@berelax/shared'

/**
 * Provenance: what a source row hashes to, and how an imported entity row resolves back to it.
 *
 * ## Why the hash is over a CANONICAL form and not over the line
 *
 * There is no incumbent export (H-MIG-01's summary says so), so the source of every figure that arrives
 * through this schema is a spreadsheet a human typed. Two consequences follow and both shape this module.
 *
 * First, the file's BYTES are not stable. Re-saving a spreadsheet rewrites the whole file — line endings,
 * quoting, number formatting, column order in some exports — without changing a single value anybody typed.
 * Idempotence is decided on the row hash, so hashing the raw line would re-import every row of a re-saved
 * file. {@link canonicalise} therefore hashes the PARSED payload with its keys sorted, which changes
 * exactly when a value changes.
 *
 * Second, the file's identity is nothing but its bytes: a typed spreadsheet has no version number, and its
 * filename is whatever the person who sent it called it that day. So the RUN hashes the bytes
 * ({@link fileHash}) and the ROW hashes the content, and the two answer different questions — "is this the
 * same file I was given" and "is this the same row I already imported".
 *
 * ## What `canonicalise` refuses, and why refusing is the point
 *
 * `NaN`, `Infinity` and `-Infinity` all serialise to `null` through `JSON.stringify`. A cell that arrived as
 * a division by zero would therefore hash identically to an empty cell, and two rows that are not the same
 * row would be treated as one — silently, on the idempotence path, which is where a wrong answer means a
 * missing row rather than a duplicate one. `undefined` is dropped for the same class of reason: a key whose
 * value is absent and a key that is not there are the same fact, and hashing them differently would make
 * idempotence depend on which of the two an importer's parser happened to produce.
 */

/** A relation this module will address: schema-qualified, lower case, no quoting games. */
const RELATION = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/

export const PROVENANCE_VIEW = 'import_staging.entity_provenance'

/** An imported entity row, as the importer reports it back to the framework. */
export interface ImportedEntity {
  /** Defaults to `public`, which is where all but one of the H-MIG target tables live. */
  readonly schema?: string
  readonly table: string
  /** The row's primary key as text. `text` and not `uuid`: `package_template` is keyed by a code. */
  readonly id: string
}

/** Where an imported entity row came from, resolved through {@link PROVENANCE_VIEW}. */
export interface ResolvedProvenance {
  readonly targetSchema: string
  readonly targetTable: string
  readonly targetId: string
  readonly sourceFile: string
  readonly sourceFileHash: string
  readonly sourceLine: number
  readonly contentHash: string
  readonly importer: string
  readonly importerVersion: string
  readonly runId: string
}

export function assertRelationName(relation: string): string {
  if (!RELATION.test(relation)) {
    throw new AppError(
      'validation',
      `"${relation}" is not a schema-qualified relation name. Every target table is named ` +
        'schema-qualified so that a provenance row, a checksum and a coverage read cannot disagree about ' +
        'which table they are about — "package_sale" resolves through the search_path and ' +
        '"public.package_sale" does not.',
      { details: { relation } },
    )
  }
  return relation
}

/**
 * A deterministic string for any JSON-shaped value: object keys sorted, arrays in order.
 *
 * Exported because it is the thing worth testing on its own, and because an importer that needs to hash a
 * sub-structure must use the same function rather than a second one.
 */
export function canonicalise(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AppError(
        'validation',
        `A source value of ${String(value)} cannot be hashed: JSON.stringify turns it into null, so it ` +
          'would hash identically to an empty cell and the idempotence check would treat two different ' +
          'rows as one.',
      )
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalise(item)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalise(item)}`)
    return `{${entries.join(',')}}`
  }
  throw new AppError(
    'validation',
    `A source value of type ${typeof value} cannot be hashed. A staged payload is JSON, because it is ` +
      'stored as jsonb and read back by a report that has to say what was imported.',
  )
}

/** sha-256, lower-case hex, of the canonical form of a parsed source row. */
export const contentHash = (payload: unknown): string =>
  createHash('sha256').update(canonicalise(payload), 'utf8').digest('hex')

/** sha-256, lower-case hex, of the source file's bytes. The only identity a typed spreadsheet has. */
export const fileHash = (bytes: Uint8Array | string): string =>
  createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex')

/**
 * Records that one imported entity row came from one staged source row.
 *
 * Takes a {@link UnitOfWork} and not a pool, deliberately: provenance has to be durable with the entity it
 * describes or with neither, and the compiling-but-wrong call is the one worth making impossible. ZY196
 * refuses the COMMIT if this was not called for a row the framework marked `applied`, and ZY194 refuses a
 * target the run did not declare.
 */
export async function recordProvenance(
  uow: UnitOfWork,
  importRowId: string,
  entity: ImportedEntity,
): Promise<string> {
  const rows = await uow.sql<{ id: string }[]>`
    insert into import_staging.import_provenance (import_row_id, target_schema, target_table, target_id)
    values (
      ${importRowId}::uuid,
      ${entity.schema ?? 'public'},
      ${entity.table},
      ${entity.id}
    )
    returning id
  `
  const id = rows[0]?.id
  if (id === undefined) {
    throw new AppError(
      'invariant_violated',
      'The provenance insert returned no row, which cannot happen for an INSERT ... RETURNING that did ' +
        'not raise. Treated as a failure rather than ignored: the alternative is an applied row whose ' +
        'provenance nobody holds an id for.',
    )
  }
  return id
}

/** Where one imported entity row came from, or `null` if nothing recorded it. */
export async function resolveProvenance(
  sql: Sql,
  entity: ImportedEntity,
): Promise<ResolvedProvenance | null> {
  const rows = await sql<ResolvedProvenance[]>`
    select target_schema     as "targetSchema",
           target_table      as "targetTable",
           target_id         as "targetId",
           source_file       as "sourceFile",
           source_file_hash  as "sourceFileHash",
           source_line       as "sourceLine",
           content_hash      as "contentHash",
           importer          as "importer",
           importer_version  as "importerVersion",
           run_id            as "runId"
      from import_staging.entity_provenance
     where target_schema = ${entity.schema ?? 'public'}
       and target_table = ${entity.table}
       and target_id = ${entity.id}
  `
  return rows[0] ?? null
}

/**
 * The ids of rows in a target relation that no provenance row names.
 *
 * The measured half of "100% provenance coverage", and it is measured rather than asserted for a reason
 * ZY196 cannot cover: a row inserted by hand, by a seed, or by an importer that went round `runImport`
 * satisfies ZY196 trivially, because there is no staged row at all. This reads the target table instead.
 *
 * It is a thin wrapper over `import_staging.unprovenanced_row_ids` rather than the query itself, so the
 * report and every suite ask the same question of the same implementation — which also means the ZY199
 * refusal (a relation provenance cannot address) reaches a caller instead of being answered with an empty
 * list that reads as full coverage.
 */
export async function unprovenancedRowIds(sql: Sql, relation: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select import_staging.unprovenanced_row_ids(${assertRelationName(relation)}::regclass) as id
  `
  return rows.map((row) => row.id)
}
