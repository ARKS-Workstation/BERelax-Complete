import {
  type ContraindicationDerivation,
  type ContraindicationFreshness,
  resolveContraindicationFreshness,
  type StoredFlagProvenance,
} from '@berelax/core'
import type { Sql, UnitOfWork } from '@berelax/db'
import { CONTRAINDICATION_DERIVATION_VERSION, type ContraindicationFlagSet } from '@berelax/shared'

/**
 * The clinical side of the boolean-only crossing (C-CRM-09).
 *
 * `packages/core/src/clinical/contraindication-flags.ts` decides what the flags ARE; this writes the row
 * they live in and answers the questions that need the clinical schema. Everything here runs behind the
 * boundary: `0009` revokes all privileges on `clinical` from `berelax_app`, so nothing in this file is
 * reachable over the application credential at all.
 *
 * ## Why the READER of the crossing is not in this file, or anywhere in this package
 *
 * The obvious home for "read this client's flags" is beside the code that writes them, and it is the wrong
 * one. Every consumer of the crossing is in the booking layer — the diary, the client record, a therapist's
 * screen — and if the reader lived here then every one of those would import `@berelax/clinical`, which is
 * the package holding the envelope, the KEK parser and the store. The dependency-cruiser rule that keeps
 * the review generator away from clinical data (`reviews-generator-must-not-reach-clinical-data`) would
 * then be the only thing standing between a prompt builder and a package the whole application depends on.
 *
 * So the reader is `packages/db/src/repositories/contraindication-flags.ts`: it selects from
 * `public.customer_contraindication_flags` over the application credential, needs no clinical privilege,
 * holds no key, and imports nothing from this package. That is what "boolean-only crossing" means as an
 * arrangement of modules rather than as a claim about a type.
 *
 * ## What is written, and what is deliberately not
 *
 * The row carries the eight booleans, the submission they came from, the derivation version, the template
 * version that submission was captured under, and how many answers the derivation refused to interpret.
 * It carries no answer, no question key, no label and no free text of any kind.
 *
 * The AUDIT row carries even less: the versions, the counts and whether anything changed — and **not the
 * flags themselves**. That is a decision rather than an omission. `audit:read` is held by the owner, the
 * manager, the accountant and the AUDITOR, and of those four only the owner and the manager hold the
 * `clinical.flags` field group (`packages/core/src/access/permissions.ts`). Putting the flag set on the
 * audit row would hand a client's contraindications to two roles the permission matrix refuses them to,
 * through a table that is append-only and therefore cannot be corrected.
 */

/** The eight columns, in `CONTRAINDICATION_FLAG_KEYS` order. The column name IS the flag key. */
const flagValues = (flags: ContraindicationFlagSet) => ({
  pregnancy: flags.pregnancy,
  recentSurgery: flags.recent_surgery,
  cardiovascular: flags.cardiovascular,
  skinCondition: flags.skin_condition,
  allergyPresent: flags.allergy_present,
  bloodThinners: flags.blood_thinners,
  acuteInjury: flags.acute_injury,
  requiresConsultation: flags.requires_consultation,
})

interface StoredFlagRow {
  readonly pregnancy: boolean
  readonly recentSurgery: boolean
  readonly cardiovascular: boolean
  readonly skinCondition: boolean
  readonly allergyPresent: boolean
  readonly bloodThinners: boolean
  readonly acuteInjury: boolean
  readonly requiresConsultation: boolean
}

const toFlagSet = (row: StoredFlagRow): ContraindicationFlagSet =>
  Object.freeze({
    pregnancy: row.pregnancy,
    recent_surgery: row.recentSurgery,
    cardiovascular: row.cardiovascular,
    skin_condition: row.skinCondition,
    allergy_present: row.allergyPresent,
    blood_thinners: row.bloodThinners,
    acute_injury: row.acuteInjury,
    requires_consultation: row.requiresConsultation,
  })

/**
 * The flag set as the CLINICAL side holds it, straight off the table.
 *
 * Not the same answer as the view's, and the difference is the point rather than a bug: the view ORs
 * staleness into `requires_consultation` (migration 0084), so the row says what the derivation found and
 * the view says what the front desk must do. A test that compared them without knowing that would be
 * asserting the wrong equality.
 */
export async function storedContraindicationFlags(
  tx: Sql,
  customerId: string,
): Promise<ContraindicationFlagSet | null> {
  const [row] = await tx<StoredFlagRow[]>`
    select pregnancy,
           recent_surgery        as "recentSurgery",
           cardiovascular,
           skin_condition        as "skinCondition",
           allergy_present       as "allergyPresent",
           blood_thinners        as "bloodThinners",
           acute_injury          as "acuteInjury",
           requires_consultation as "requiresConsultation"
      from clinical.contraindication_flag
     where customer_id = ${customerId}::uuid
  `
  return row === undefined ? null : toFlagSet(row)
}

/** The provenance the staleness verdict is computed from, or null when nothing has been derived. */
export async function storedFlagProvenance(
  tx: Sql,
  customerId: string,
): Promise<StoredFlagProvenance | null> {
  const [row] = await tx<
    {
      derivationVersion: number
      sourceSubmissionId: string
      sourceTemplateVersion: number
    }[]
  >`
    select derivation_version      as "derivationVersion",
           source_submission_id    as "sourceSubmissionId",
           source_template_version as "sourceTemplateVersion"
      from clinical.contraindication_flag
     where customer_id = ${customerId}::uuid
  `
  if (row === undefined) return null
  return {
    derivationVersion: Number(row.derivationVersion),
    sourceSubmissionId: row.sourceSubmissionId,
    sourceTemplateVersion: Number(row.sourceTemplateVersion),
  }
}

/**
 * The staleness verdict WITH its reason, for a reader who is allowed to know why.
 *
 * The view's `requires_consultation` already carries the fact, because a consumer must not be able to skip
 * it. This carries the reason, and it needs the clinical schema for all three of its inputs — which is
 * exactly why the fact and the reason are separated: the front desk gets one boolean it cannot ignore, and
 * the clinical screen gets the sentence.
 *
 * The SQL half of the same rule is `clinical.contraindication_flags_are_stale()`; the two are asserted to
 * agree in `flags-view.itest.ts` over every case rather than assumed to.
 */
export async function contraindicationFreshness(
  tx: Sql,
  customerId: string,
): Promise<ContraindicationFreshness> {
  const stored = await storedFlagProvenance(tx, customerId)
  const [live] = await tx<
    { submissionId: string; templateVersion: number; currentTemplateVersion: number | null }[]
  >`
    select s.id                as "submissionId",
           s.template_version  as "templateVersion",
           (select max(t2.version)
              from clinical.intake_form_template t2
             where t2.locale = t.locale) as "currentTemplateVersion"
      from clinical.intake_submission s
      join clinical.intake_form_template t on t.id = s.template_id
     where s.customer_id = ${customerId}::uuid and s.superseded_at is null
     order by s.submitted_at desc, s.id desc
     limit 1
  `
  return resolveContraindicationFreshness({
    stored,
    liveSubmission:
      live === undefined
        ? null
        : { submissionId: live.submissionId, templateVersion: Number(live.templateVersion) },
    currentTemplateVersion:
      live?.currentTemplateVersion === null || live?.currentTemplateVersion === undefined
        ? null
        : Number(live.currentTemplateVersion),
    currentDerivationVersion: CONTRAINDICATION_DERIVATION_VERSION,
  })
}

export interface ContraindicationWriteResult {
  readonly flags: ContraindicationFlagSet
  readonly derivationVersion: number
  readonly sourceTemplateVersion: number
  readonly undeterminedCount: number
  /** Whether this derivation changed any flag. False on a re-derivation that agreed with the row. */
  readonly changed: boolean
}

/**
 * Writes a derived flag set, and records that it was derived.
 *
 * An UPSERT keyed on `customer_id`, which is the table's primary key: there is one live flag set per client
 * and a re-derivation replaces it. The superseded row is NOT kept, and that is the one place this unit
 * departs from the append-only habit of the clinical schema — deliberately, because a flag set is not
 * evidence. The evidence is the submission, which is retained and superseded (ADR 0010) and still decrypts;
 * these eight booleans are a function of it, recomputable at any time, and a history of them would be a
 * growing record of somebody's health conditions kept for no reason anybody could state. The audit trail
 * holds what changed and when, which is what a dispute needs.
 *
 * `changed` is computed by reading the previous row inside the same transaction. It exists because the
 * useful question after a re-derivation is not "did it run" but "did the answer move", and an audit row
 * that cannot distinguish the two makes a sweep over every client indistinguishable from a real change.
 */
export async function writeContraindicationFlags(
  uow: UnitOfWork,
  args: {
    readonly customerId: string
    readonly submissionId: string
    readonly derivation: ContraindicationDerivation
  },
): Promise<ContraindicationWriteResult> {
  const tx = uow.sql
  const { derivation } = args
  const previous = await storedContraindicationFlags(tx, args.customerId)
  const v = flagValues(derivation.flags)
  const undeterminedCount = derivation.undetermined.length

  await tx`
    insert into clinical.contraindication_flag
      (customer_id, pregnancy, recent_surgery, cardiovascular, skin_condition, allergy_present,
       blood_thinners, acute_injury, requires_consultation, updated_at, source_submission_id,
       derivation_version, source_template_version, undetermined_count)
    values (
      ${args.customerId}::uuid, ${v.pregnancy}, ${v.recentSurgery}, ${v.cardiovascular},
      ${v.skinCondition}, ${v.allergyPresent}, ${v.bloodThinners}, ${v.acuteInjury},
      ${v.requiresConsultation}, now(), ${args.submissionId}::uuid,
      ${derivation.derivationVersion}, ${derivation.sourceTemplateVersion}, ${undeterminedCount}
    )
    on conflict (customer_id) do update set
      pregnancy               = excluded.pregnancy,
      recent_surgery          = excluded.recent_surgery,
      cardiovascular          = excluded.cardiovascular,
      skin_condition          = excluded.skin_condition,
      allergy_present         = excluded.allergy_present,
      blood_thinners          = excluded.blood_thinners,
      acute_injury            = excluded.acute_injury,
      requires_consultation   = excluded.requires_consultation,
      updated_at              = excluded.updated_at,
      source_submission_id    = excluded.source_submission_id,
      derivation_version      = excluded.derivation_version,
      source_template_version = excluded.source_template_version,
      undetermined_count      = excluded.undetermined_count
  `

  const changed =
    previous === null ||
    Object.entries(derivation.flags).some(
      ([key, value]) => previous[key as keyof ContraindicationFlagSet] !== value,
    )

  // No flag VALUES on the audit row. See the file header: `audit:read` reaches two roles that the
  // permission matrix refuses the `clinical.flags` field group to, and `audit_event` is append-only, so a
  // disclosure written here cannot be taken back.
  await uow.audit.record({
    action: 'clinical.contraindication_flag.derived',
    entityType: 'clinical.contraindication_flag',
    entityId: args.customerId,
    operation: previous === null ? 'create' : 'update',
    after: {
      sourceSubmissionId: args.submissionId,
      derivationVersion: derivation.derivationVersion,
      sourceTemplateVersion: derivation.sourceTemplateVersion,
      undeterminedCount,
      notAskedCount: derivation.notAsked.length,
      changed,
    },
  })

  return {
    flags: derivation.flags,
    derivationVersion: derivation.derivationVersion,
    sourceTemplateVersion: derivation.sourceTemplateVersion,
    undeterminedCount,
    changed,
  }
}
