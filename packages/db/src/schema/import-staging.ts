import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle mirrors of the `import_staging` schema (migration 0111, H-MIG-01).
 *
 * Hand-written, because migrations are SQL-first (ADR 0006); `pnpm db:drift` compares these against the
 * live database in both directions, and it resolves the Postgres schema from the `pgSchema(...)` call each
 * table is built on — so `importStagingSchema` below is what makes these findable rather than decoration,
 * and `OWNED_SCHEMAS` in `scripts/check-schema-drift.mjs` is what makes them required.
 *
 * ## Five things the mirror cannot say, and each of them will bite a caller who writes from these
 * definitions instead of reading 0111
 *
 *   1. **`importProvenance` is append-only.** UPDATE and DELETE raise `ZY195`, and the application role
 *      holds neither privilege. A `db.update(importProvenance)` typechecks and is refused by the server.
 *   2. **`importRow` accepts exactly one UPDATE: `pending` -> a terminal outcome**, with the two columns
 *      that describe it. Any other column change, any change out of a terminal state, and any DELETE raise
 *      `ZY192`. That is what stops a resumed run re-applying a row a killed attempt already applied.
 *   3. **An `importRow` reaching `applied` must carry provenance by COMMIT** (`ZY196`, a DEFERRED
 *      constraint trigger). The write path that satisfies it is `runImport` in `@berelax/migration` and
 *      nothing else — which is a claim about the repository, held by
 *      `packages/migration/src/write-path.test.ts`, not a claim the schema can make.
 *   4. **No row here is ever deleted.** Both foreign keys are `ON DELETE RESTRICT` and the application role
 *      holds no DELETE or TRUNCATE anywhere in the schema. The staging ledger is the evidence that an
 *      import happened and what it read; a run that should not have happened is recorded as having
 *      happened.
 *   5. **`entityProvenance` is a VIEW and is deliberately not mirrored.** `pnpm db:drift` compares base
 *      tables (`relkind in ('r', 'p')`), and `employee_gratuity_liability`, `commission_derivation` and
 *      `regulatory_profile_current` set the precedent. It is the one place (target row) -> (file, line,
 *      content hash) is written, and `@berelax/migration` reads it by name.
 *
 * `amount_fils` on the probe entity is `bigint` with `mode: 'number'`, which is what `./payroll.ts` and
 * `./commission.ts` do for their sibling money columns. The column is a `fils` domain in the database; the
 * mirror has no way to say so, and `pnpm db:drift` compares presence and not type.
 */
export const importStagingSchema = pgSchema('import_staging')

/**
 * One import of one source file (0111).
 *
 * A resumed import is the SAME row continuing, never a second row: `ZY191` refuses a second `running` run
 * for the same `(importer, sourceFileHash)`, because two processes staging and applying one file cannot see
 * each other's uncommitted rows and idempotence cannot save them.
 *
 * `mode` is `'dry-run' | 'live'` and NO dry-run row survives a completed dry run: the whole run happens
 * inside one transaction that is rolled back. The column exists because the rows staged inside that
 * transaction need a run to hang off, and so that a dry run found committed — which would mean a crash
 * between the rollback and the process exit — is distinguishable from a live one.
 *
 * `targetTables` is load-bearing twice: `ZY194` refuses provenance naming a table not in it, and the
 * report's before/after checksums are taken over exactly this list. So "the tables this import touched" is
 * complete rather than hopeful.
 */
export const importRun = importStagingSchema.table(
  'import_run',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    importer: text('importer').notNull(),
    /** The importer's own version. A discrepancy can be caused by the code as much as by a typed digit. */
    importerVersion: text('importer_version').notNull(),
    sourceFile: text('source_file').notNull(),
    /** sha-256 of the file bytes, lower-case hex: the only identity a typed spreadsheet has. */
    sourceFileHash: text('source_file_hash').notNull(),
    mode: text('mode').notNull(),
    state: text('state').notNull(),
    targetTables: text('target_tables').array().notNull(),
    resumedCount: integer('resumed_count').notNull().default(0),
    actorLabel: text('actor_label').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    check('import_run_mode_known', sql`${table.mode} in ('dry-run', 'live')`),
    check('import_run_state_known', sql`${table.state} in ('running', 'completed', 'failed')`),
    index('import_run_importer_file').on(table.importer, table.sourceFileHash),
  ],
)

/**
 * One row of one source file, as read (0111).
 *
 * The `payload` is kept rather than re-read, because the file will be edited: this is the copy of row 214
 * that was actually imported, and it is what makes the run answerable afterwards.
 *
 * `rowHash` is over the CANONICAL content, not over the raw line — a re-saved spreadsheet moves every byte
 * of every line and must not re-import a single row. Idempotence is decided on this value against the
 * `applied` rows of COMPLETED runs.
 */
export const importRow = importStagingSchema.table(
  'import_row',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => importRun.id, { onDelete: 'restrict' }),
    lineNumber: integer('line_number').notNull(),
    rowHash: text('row_hash').notNull(),
    payload: jsonb('payload').notNull(),
    state: text('state').notNull().default('pending'),
    /** Required for `skipped` and `rejected`, refused for the others. */
    outcomeDetail: text('outcome_detail'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'import_row_state_known',
      sql`${table.state} in ('pending', 'applied', 'skipped', 'rejected')`,
    ),
    unique('import_row_one_per_line').on(table.runId, table.lineNumber),
  ],
)

/**
 * Which imported entity row came from which staged source row (0111).
 *
 * It carries NO copy of the file, the line or the hash. Those live once each — on `importRun` and
 * `importRow` — and resolve through the `import_staging.entity_provenance` view, which is the only place
 * the join is written. Denormalising them here would be faster to read and would let provenance claim a
 * file hash the run does not have, with the claim still resolving.
 *
 * `targetId` is `text` because not every imported entity has a uuid key: `package_template` is keyed by a
 * code. A uuid column would push the one importer with a natural key into keeping its provenance somewhere
 * else, and "somewhere else" is how coverage stops being 100%.
 */
export const importProvenance = importStagingSchema.table(
  'import_provenance',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    importRowId: uuid('import_row_id')
      .notNull()
      .references(() => importRow.id, { onDelete: 'restrict' }),
    targetSchema: text('target_schema').notNull(),
    targetTable: text('target_table').notNull(),
    targetId: text('target_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('import_provenance_one_per_target').on(
      table.targetSchema,
      table.targetTable,
      table.targetId,
    ),
    index('import_provenance_row').on(table.importRowId),
    index('import_provenance_target_relation').on(table.targetSchema, table.targetTable),
  ],
)

/**
 * The framework's conformance target, and nothing else reads it (0111).
 *
 * It exists so H-MIG-01's five claims — idempotence, resumability, dry run, provenance coverage, rollback —
 * are proved against a real table with real constraints, a real checksum and a real deferred trigger rather
 * than against a mock, which is the arrangement `packages/payments/src/conformance/fixtures` already uses
 * for adapters that are deliberately broken. A real importer naming this table would be recording a domain
 * figure where nothing looks for it, and `packages/migration/src/write-path.test.ts` refuses one.
 */
export const importProbeEntity = importStagingSchema.table('import_probe_entity', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  probeKey: text('probe_key').notNull().unique(),
  label: text('label').notNull(),
  amountFils: bigint('amount_fils', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
