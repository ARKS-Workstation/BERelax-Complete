import { AppError } from '@berelax/shared'

/**
 * The SQLSTATEs `packages/db/migrations/0111_migration_staging.sql` raises, and the one translator for them.
 *
 * Every code is allocated in `packages/db/src/sqlstate-registry.ts` (ADR 0043) and every entry there names
 * THIS file as its translator, which is why no other module in `@berelax/migration` holds one of these as a
 * literal: `pnpm sqlstate` checks the translator list in both directions, so a second module carrying a code
 * fails the build until the registry names it too. A test file may hold one — the registry's scan excludes
 * `*.test.ts` and `*.itest.ts`, because a probe asserting a code is not a layer that reports it.
 *
 * The match is on SQLSTATE alone. Matching on the message would make the translation depend on wording, and
 * a reworded message would silently stop translating — after which the caller that treats "this run is
 * already open, resume it" as an unknown failure is the caller that starts a second one.
 */
export const MIGRATION_SQLSTATE = {
  /** A second run of the same importer and source file was opened while one was still running. */
  runAlreadyOpen: 'ZY191',
  /** A staged row's evidence or its terminal outcome was changed, or the row was deleted. */
  stagedRowImmutable: 'ZY192',
  /** A row was staged against a run that has already finished. */
  runClosed: 'ZY193',
  /** Provenance named a target table the run did not declare. */
  undeclaredTarget: 'ZY194',
  /** A provenance row was updated or deleted. */
  provenanceAppendOnly: 'ZY195',
  /** A staged row reached `applied` with no provenance row naming it, refused at COMMIT. */
  missingProvenance: 'ZY196',
  /** A content checksum was asked for over a relation with no columns left after the exclusions. */
  emptyChecksum: 'ZY197',
  /** A run was completed while rows were still pending. */
  pendingRowsAtCompletion: 'ZY198',
  /** A provenance coverage read was asked for over a relation without a single-column primary key. */
  unreadableCoverageTarget: 'ZY199',
} as const

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a refusal from the `import_staging` schema into an `AppError`, or `null` for anything else.
 *
 * The KINDS are chosen by what the caller has to go and do, which is the only question a kind answers:
 *
 *   - `conflict` for ZY191 and ZY198 — nothing about the caller's data is wrong. Another run holds the
 *     file, or rows are still pending; the answer is to resume or to finish, not to correct anything.
 *   - `forbidden` for ZY192 and ZY195 — the statement will never be permitted, for any caller, with any
 *     data. A correction is a new import.
 *   - `invariant_violated` for ZY196 — the framework, not the caller, failed to record provenance. A
 *     validation failure would send whoever reads it looking at the spreadsheet.
 *   - `validation` for ZY193, ZY194 and ZY199 — the importer asked for something incoherent: a closed run,
 *     an undeclared table, a relation provenance cannot address.
 *   - `invariant_violated` for ZY197 — a checksum over no columns means a caller excluded every column,
 *     and the measurement it was about to make would have compared equal for ever.
 */
export function migrationError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  const details = { sqlState: code }
  switch (code) {
    case MIGRATION_SQLSTATE.runAlreadyOpen:
    case MIGRATION_SQLSTATE.pendingRowsAtCompletion:
      return new AppError('conflict', message, { details })
    case MIGRATION_SQLSTATE.stagedRowImmutable:
    case MIGRATION_SQLSTATE.provenanceAppendOnly:
      return new AppError('forbidden', message, { details })
    case MIGRATION_SQLSTATE.missingProvenance:
    case MIGRATION_SQLSTATE.emptyChecksum:
      return new AppError('invariant_violated', message, { details })
    case MIGRATION_SQLSTATE.runClosed:
    case MIGRATION_SQLSTATE.undeclaredTarget:
    case MIGRATION_SQLSTATE.unreadableCoverageTarget:
      return new AppError('validation', message, { details })
    default:
      return null
  }
}

export const isMissingProvenanceRefusal = (err: unknown): boolean =>
  sqlState(err) === MIGRATION_SQLSTATE.missingProvenance

export const isRunAlreadyOpenRefusal = (err: unknown): boolean =>
  sqlState(err) === MIGRATION_SQLSTATE.runAlreadyOpen
