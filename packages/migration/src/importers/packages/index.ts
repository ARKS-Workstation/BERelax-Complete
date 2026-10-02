/**
 * The package reconstruction importer, both halves, as one subpath.
 *
 * H-MIG-02 shipped `workbook.ts`, `validate.ts` and the fixtures and exported none of them from the
 * package root: nothing outside this directory needed them, and its own suites import the modules
 * directly. H-MIG-03 is what gives them a consumer — the pairing suite in `packages/fixtures`, which may
 * depend on `@berelax/core` and `@berelax/db` and is therefore the only place the importer can be driven
 * against a real database beside the pure arithmetic, and `scripts/migrate-package-liability.mjs`, which
 * is the door a person runs the import through.
 *
 * So this file names the two halves' public surface once, rather than each consumer reaching three
 * directories deep into another package's `src` and picking a different subset. It re-exports and states
 * nothing of its own: a constant declared here would be a fourth place one of these names lives.
 */

export {
  PACKAGES_IMPORTER_NAME,
  PACKAGES_IMPORTER_TARGETS,
  PACKAGES_IMPORTER_VERSION,
  type PackagesImporterOptions,
  packagesImporter,
} from './import.ts'
export {
  createPackageWorkbookValidator,
  formatWorkbookRejections,
  type KnownPackageTemplate,
  PACKAGE_REJECTION_REASONS,
  PACKAGE_REJECTIONS,
  type PackageRejection,
  type PackageValidatorOptions,
  validatePackageWorkbook,
  type WorkbookRejection,
  type WorkbookValidationReport,
} from './validate.ts'
export {
  buildPackageWorkbook,
  EVIDENCE_KINDS,
  fillPackageWorkbook,
  OWNER_SIGN_OFF_VALUE,
  type PackageWorkbookRow,
  parsePackageWorkbook,
  renderWorkbookRow,
  WORKBOOK_COLUMNS,
  WORKBOOK_HEADER,
  WORKBOOK_PAYLOAD_KEYS,
  type WorkbookColumn,
  type WorkbookTemplate,
  type WorkbookTerms,
} from './workbook.ts'
