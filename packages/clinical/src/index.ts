/**
 * @berelax/clinical — the clinical data boundary.
 *
 * Everything here is designed to be RELOCATABLE. If the licence classification turns out to make
 * UAE data localisation apply (OPEN-QUESTIONS Y5-residency), the clinical store moves to a
 * UAE-hosted database and nothing outside this package changes — because nothing outside this
 * package talks to the clinical schema, and no foreign key crosses the boundary.
 */
export {
  createMemoryClinicalKeyStore,
  type MemoryClinicalKeyStore,
} from './crypto/memory-key-store.ts'
export { createPostgresClinicalKeyStore } from './crypto/postgres-key-store.ts'
export {
  bindingFor,
  CLINICAL_KEK_ERRORS,
  CLINICAL_SEALED_TABLES,
  type ClinicalKeyStore,
  type ClinicalSealedTable,
  contentChecksum,
  type KekRotationReport,
  type KekVersionRow,
  type RewrapWrite,
  rotateClinicalKek,
  rotationChecksum,
  type SealedRecord,
  sealUnderActiveKek,
  type VerifiedRecord,
  verifyRecord,
} from './crypto/rotate.ts'
export {
  fingerprint,
  generateKek,
  type Kek,
  open,
  parseKek,
  type RecordBinding,
  rewrap,
  type SealedPayload,
  seal,
} from './envelope.ts'
export {
  type ContraindicationWriteResult,
  contraindicationFreshness,
  storedContraindicationFlags,
  storedFlagProvenance,
  writeContraindicationFlags,
} from './flags-view.ts'
export type {
  ClinicalErrorSink,
  ClinicalLogFields,
  ClinicalLogger,
  ClinicalLogLevel,
  ClinicalLogLine,
  ClinicalLogValue,
} from './logging.ts'
export { SILENT_CLINICAL_LOGGER } from './logging.ts'
export {
  type ClinicalActor,
  type ClinicalIntakeStore,
  type ClinicalStoreDeps,
  createClinicalIntakeStore,
  type DerivedFlagsResult,
  type DeriveFlagsInput,
  type GrantStepUpInput,
  type IntakeReadResult,
  type PublishedTemplate,
  type PublishTemplateInput,
  type ReadIntakeInput,
  type RecordIntakeInput,
  type StepUpGranted,
} from './repository.ts'
export type { ClinicalStore, ContraindicationFlags } from './store.ts'
