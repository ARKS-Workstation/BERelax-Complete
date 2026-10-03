import type { GbpConsistencyFinding } from '@berelax/core'
import type { GbpSnapshotForm } from '@berelax/google'

/**
 * The GBP snapshot screen's vocabulary: the path, the field names and the view (G-SEO-06).
 *
 * Separated from the render and the handler because all three need the same strings, and a literal in
 * three files is three chances for one of them to be the typo that makes a field arrive empty — the
 * reason `SEO_SUGGESTIONS_FIELDS` next door exists.
 */

/** The route. One constant, so the form's `action` and the registry entry cannot disagree. */
export const GBP_SNAPSHOT_PATH = '/agents/seo/gbp-snapshot'

/**
 * The permission this screen requires, in both verbs.
 *
 * `integration:connect` and not `content:publish`: nothing here publishes, and nothing here changes a
 * row the public can see. What it does is record **a claim about the business's Google listing**, which
 * is the same subject as the connection itself — and the person who can look at that listing is the
 * person Google shows it to. Only the owner holds it (`ROLE_DEFINITIONS.owner.permissions` is `all`),
 * and that is a consequence rather than an accident: a snapshot is evidence this build cannot check, so
 * who may record one is a decision and not a convenience.
 *
 * This is the first caller of the permission, which is the other reason it is named here rather than
 * folded into a wider one: a permission nothing checks is a rule a reader believes exists (ADR 0002).
 */
export const GBP_SNAPSHOT_PERMISSION = 'integration:connect' as const

/**
 * The form field names.
 *
 * The day and price fields are NAMED BY THE CHECKER (`manualSnapshotForm`), so this holds only the two
 * that are not per-subject. A screen that invented its own field names would be a second statement of
 * which subjects can be snapshotted, and the first divergence would be a field the comparison refuses.
 */
export const GBP_SNAPSHOT_FIELDS = {
  /** The instant the person says they looked at the profile. */
  observedAt: 'observed-at',
  action: 'action',
} as const

/** Why a submission was refused, by name. A closed set, so a refusal with no wording is a type error. */
export const GBP_SNAPSHOT_REFUSALS = [
  'unreadable_request',
  'forbidden',
  'nothing_transcribed',
  'unreadable_value',
  'write_refused',
] as const
export type GbpSnapshotRefusal = (typeof GBP_SNAPSHOT_REFUSALS)[number]

export interface GbpSnapshotView {
  /** The instant the page was read at, printed, so two repeat runs produce identical screenshots. */
  readonly readAtIso: string
  /** The audit label this screen acts under: the employment handle, never a name (ADR 0020). */
  readonly actorLabel: string
  /** Whether the Google figures were read or claimed, in words. Null when nothing has been compared. */
  readonly provenance: string | null
  readonly mode: 'api' | 'manual_snapshot'
  /** Null when the API answered: there is then nothing for a person to transcribe. */
  readonly form: GbpSnapshotForm | null
  readonly findings: readonly GbpConsistencyFinding[]
  /** True once a comparison has been made, so "no findings" is distinguishable from "not run". */
  readonly compared: boolean
  readonly refusal: GbpSnapshotRefusal | null
  readonly refusalDetail: string | null
  /** True after a successful POST, for the line after the 303. */
  readonly recorded: boolean
  /** False when this role may not record a claim: the form is shown read-only rather than hidden. */
  readonly mayRecord: boolean
}
