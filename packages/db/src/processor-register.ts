/**
 * The processor register, from the one place it is stated.
 *
 * The manifest names this path, and the DATA is in `packages/shared/src/processor-register.ts` for
 * `crawlers.ts`'s reason: `packages/db` may reach `shared` and must never import `core` (ADR 0001), and
 * the thing that GENERATES the privacy policy from these rows is in `core`. A table both sides derive
 * from has no business on the wrong side of that boundary, so this file is a re-export and there is
 * exactly one statement of the register.
 *
 * It is a re-export and not a copy on purpose. The alternative — the rows here and a test asserting the
 * two lists are equal — is the shape ADR 0062 rejected for the crawler lists and ADR 0043 rejected for
 * SQLSTATE classes: a set-equality test between two hand-written lists passes the day it is written, is
 * the first thing deleted when somebody adds a provider in a hurry, and says nothing at all about a
 * third copy.
 *
 * There is deliberately no `processor` TABLE. The register is a closed set that changes only when code
 * changes — adding a processor means adding a provider key, an adapter and an egress allowance — so a
 * table would be a second place to change, with a migration, and the one that drifts would be the one
 * the privacy policy reads. `scripts/check-processor-register.mjs` holds the register against the config
 * schema in both directions, which is the check a table could not give.
 */
export {
  PROCESSOR_AGREEMENT_OPEN_QUESTION_ID,
  PROCESSOR_CONFIG_KEYS,
  PROCESSOR_DATA_CLASSES,
  PROCESSOR_IDS,
  PROCESSOR_PURPOSES,
  PROCESSOR_REGISTER,
  PROCESSOR_RESIDENCY_OPEN_QUESTION_ID,
  type Processor,
  type ProcessorDataClass,
  type ProcessorPurpose,
  processorById,
  TRANSFER_BASES,
  type TransferBasis,
} from '@berelax/shared'
