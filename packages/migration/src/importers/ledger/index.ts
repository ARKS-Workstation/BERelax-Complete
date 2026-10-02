/**
 * The opening-balance importer's public surface, as one subpath.
 *
 * The same consumers H-MIG-03's, H-MIG-04's, H-MIG-05's and H-MIG-06's `index.ts` exist for:
 * `packages/fixtures`, which may depend on `@berelax/core` and `@berelax/db` and is therefore the only
 * place the importer can be driven against a real database beside the pure modules, and the script a
 * person runs the import through.
 *
 * It re-exports and states nothing of its own.
 */

export {
  assertAccountsAreInTheChart,
  boxesFedByTheChart,
  type ChartAttributionGap,
  chartAttributionGaps,
} from './coa.ts'
export {
  DECLARED_OPENING_PAYLOAD_KEYS,
  OPENING_IMPORTER_NAME,
  OPENING_IMPORTER_TARGETS,
  OPENING_IMPORTER_VERSION,
  OPENING_REJECTION_REASONS,
  OPENING_REJECTIONS,
  type OpeningImporterOptions,
  type OpeningRejection,
  openingBalancesImporter,
  type RemainderCalculator,
  type StagedOpeningLine,
  type StagedOpeningPayload,
  statedPositions,
  validateStagedOpening,
} from './opening-balances.ts'
export {
  ACCOUNT_CODE,
  buildOpeningWorkbook,
  isIsoDate,
  OPENING_COLUMNS,
  OPENING_HEADER,
  type OpeningCell,
  type OpeningColumn,
  parseOpeningWorkbook,
  wholeFilsOrNaN,
} from './workbook.ts'
