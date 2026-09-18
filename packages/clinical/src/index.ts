/**
 * @berelax/clinical — the clinical data boundary.
 *
 * Everything here is designed to be RELOCATABLE. If the licence classification turns out to make
 * UAE data localisation apply (OPEN-QUESTIONS Y5-residency), the clinical store moves to a
 * UAE-hosted database and nothing outside this package changes — because nothing outside this
 * package talks to the clinical schema, and no foreign key crosses the boundary.
 */
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
export type { ClinicalStore, ContraindicationFlags } from './store.ts'
