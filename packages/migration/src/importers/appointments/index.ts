/**
 * The visit-history importer's public surface, as one subpath.
 *
 * The same consumers H-MIG-03's and H-MIG-04's `index.ts` exist for: `packages/fixtures`, which may depend
 * on `@berelax/core` and `@berelax/db` and is therefore the only place the importer can be driven against
 * a real database beside the pure modules, and the script a person runs the import through.
 *
 * It re-exports and states nothing of its own: a constant declared here would be a second place one of
 * these names lives.
 */

export {
  MINIMISED_VISIT_PAYLOAD_KEYS,
  type MinimisedVisitPayloadKey,
  planVisitHistory,
  planVisitImport,
  type StagedVisit,
  type StagedVisitPayload,
  VISIT_REJECTION_REASONS,
  VISIT_REJECTIONS,
  VISITS_IMPORTER_NAME,
  VISITS_IMPORTER_TARGETS,
  VISITS_IMPORTER_VERSION,
  type VisitImportPlan,
  type VisitRejection,
  type VisitsImporterOptions,
  validateStagedVisit,
  visitsImporter,
} from './import.ts'
export {
  buildVisitWorkbook,
  parseVisitWorkbook,
  VISIT_COLUMNS,
  VISIT_HEADER,
  VISIT_OUTCOMES,
  type VisitCell,
  type VisitColumn,
} from './workbook.ts'
