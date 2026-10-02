/**
 * The customer-list importer's public surface, as one subpath.
 *
 * H-MIG-02 exported nothing from the package root for its own importer and gave the reason: nothing
 * outside the directory needed it, and its suites import the modules directly. This file exists for the
 * same consumers H-MIG-03's `index.ts` exists for — `packages/fixtures`, which may depend on
 * `@berelax/core` and `@berelax/db` and is therefore the only place the importer can be driven against a
 * real database beside the pure normaliser, and `scripts/migrate-contacts.mjs`, which is the door a person
 * runs the import through.
 *
 * It re-exports and states nothing of its own: a constant declared here would be a second place one of
 * these names lives.
 */

export {
  type ContactImportPlan,
  type ContactKeying,
  type ContactNormaliser,
  MINIMISED_PAYLOAD_KEYS,
  type MinimisedPayloadKey,
  planContactImport,
  type StagedContact,
  type StagedContactPayload,
  stageContactCell,
} from './dedup.ts'
export {
  CONTACT_REJECTION_REASONS,
  CONTACT_REJECTIONS,
  type ContactRejection,
  CUSTOMERS_IMPORTER_NAME,
  CUSTOMERS_IMPORTER_TARGETS,
  CUSTOMERS_IMPORTER_VERSION,
  type CustomersImporterOptions,
  customersImporter,
  planContactList,
  validateStagedContact,
} from './import.ts'
export {
  buildContactWorkbook,
  CONSENT_CLAIM_VALUES,
  CONTACT_COLUMNS,
  CONTACT_HEADER,
  type ContactCell,
  type ContactColumn,
  parseContactWorkbook,
} from './workbook.ts'
