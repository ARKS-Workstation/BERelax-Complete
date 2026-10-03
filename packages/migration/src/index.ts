/**
 * `@berelax/migration` — the substrate every H-MIG importer runs on.
 *
 * Hard constraints:
 *   - it may import `@berelax/db` and `@berelax/shared`, and nothing else first-party. There is no
 *     calculation here: the arithmetic of a package balance or an opening journal belongs in
 *     `@berelax/core`, and the importer that needs it takes the answer as an argument.
 *   - every write goes through {@link runImport}. An importer's `apply` is called with the unit of work the
 *     framework opened, so the entity, its provenance, the audit row, the outbox event and the row's state
 *     transition share one transaction — which is what makes a killed import resumable rather than
 *     half-applied. `packages/migration/src/write-path.test.ts` is what keeps that true.
 *
 * **This package is not in `vitest.config.ts`'s coverage `include` list, and the reason is the one
 * `packages/db` is excluded for.** Every claim it makes is a claim about PostgreSQL — a deferred constraint
 * trigger firing at COMMIT, a checksum over a real relation, rows appearing in `audit_event` and
 * `outbox_event` — and it is proved by `framework.itest.ts` and `staging-schema.itest.ts` against a real
 * database. Counting it under the unit-test floor would either force a misleading number or invite a mock
 * target, and a mock cannot produce a COMMIT.
 */

export {
  contentChecksum,
  exactChecksum,
  GENERATED_COLUMNS,
} from './checksum.ts'
export {
  clearProbeEntities,
  PROBE_IMPORTER_NAME,
  PROBE_KEY_PREFIX,
  PROBE_REJECTIONS,
  PROBE_TARGET,
  type ProbeImporterOptions,
  probeImporter,
} from './conformance/probe-importer.ts'
export {
  type ImporterDefinition,
  type ImportMode,
  type ImportReport,
  type RowRejection,
  type RowVerdict,
  type RunImportOptions,
  runImport,
  type StagedSourceRow,
  type TargetTableReport,
} from './framework.ts'
export {
  assertRelationName,
  canonicalise,
  contentHash,
  fileHash,
  type ImportedEntity,
  PROVENANCE_VIEW,
  type ResolvedProvenance,
  recordProvenance,
  resolveProvenance,
  unprovenancedRowIds,
} from './provenance.ts'
export {
  isMissingProvenanceRefusal,
  isRunAlreadyOpenRefusal,
  MIGRATION_SQLSTATE,
  migrationError,
} from './refusals.ts'
export { IMPORTERS, importerByName, importerNames } from './registry.ts'
export {
  type DedupReading,
  generateReconciliationReport,
  IMPORT_RECORDS,
  LEAVE_LIABILITY_OPEN_QUESTION_ID,
  type LiabilityReading,
  QUARANTINE_RELATIONS,
  type QuarantinedRow,
  type QuarantineReconciliation,
  type QuarantineRelation,
  RECONCILIATION_REPORT_SCHEMA,
  type ReconciliationReport,
  type ReconciliationRun,
  readMoney,
  reconciliationExitStatus,
  recordReconciliationRun,
  reportContentBytes,
  reportContentDigest,
  SOURCE_TOTALS,
  type SourceFileReconciliation,
  unexplainedVarianceCount,
  VARIANCE_CAUSES,
  type Variance,
  type VarianceCause,
  type VarianceContribution,
  type VarianceMeasure,
  varianceOf,
} from './report/generate.ts'
export {
  ABSENT,
  type ReportFigure,
  renderReconciliationReport,
  renderReconciliationRun,
  reportFigures,
} from './report/render.ts'
