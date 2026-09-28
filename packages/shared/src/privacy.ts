import { z } from 'zod'

/**
 * The data-subject rights settings' keys, schemas and provisional values (C-CRM-10).
 *
 * Here and not in `@berelax/config` for the reason `clinical.ts` gives: packages that may not import one
 * another read them — the registry that declares the setting, `@berelax/core` which decides against them,
 * `@berelax/db` which reads them at the point of a write, and migration 0085 whose own gate asserts the
 * key string against these constants. A key spelled twice is a gate that silently stops gating.
 */

// ------------------------------------------------------------------------------------------------
// The five rights, and the deadline they are answered in
// ------------------------------------------------------------------------------------------------

/**
 * The five rights docs/04 §8 names, and there is deliberately no sixth.
 *
 * A right is not a workflow somebody adds: each of these is a distinct obligation with a distinct
 * resolution, and a free-text request type would let the front desk invent a right the engine has no
 * rule for — which is a request that gets recorded, gets a due date, and is answered by nothing.
 */
export const RIGHTS_REQUEST_TYPES = [
  'export',
  'rectification',
  'erasure',
  'objection',
  'withdrawal',
] as const
export type RightsRequestType = (typeof RIGHTS_REQUEST_TYPES)[number]

/**
 * How many days a request must be answered in. Thirty, and provisional against `Y1-entity`.
 *
 * `Y1-entity` decides which privacy law applies — mainland (Federal Decree-Law 45 of 2021), DIFC or
 * ADGM each have their own — and the build has not been told which. So this is the shortest deadline of
 * the readings the build can see rather than the one the assumed regime allows, for docs/12 §2's reason:
 * a provisional value is the strictest safe option, never the convenient one. Answering late is a breach;
 * answering early never is.
 *
 * **What relaxes if the owner answers otherwise:** a regime whose deadline is longer makes this one
 * setting change on the Unconfirmed Assumptions panel, and every request taken AFTER it is taken under the
 * new figure. Nothing else moves, because nothing else reads a deadline: the SLA is a number in a row and
 * not a branch in the code.
 *
 * **Requests already open keep the deadline they were taken under, and there is deliberately no job that
 * recomputes them.** An earlier draft declared one (`rebuild-rights-due-dates`) in the settings registry's
 * `rerunJobs`, and it was wrong twice: no worker ever registered it, so it was a rebuild that could never
 * happen — the failure `send-scheduled-step.test.ts` exists to catch on the reminder settings and which
 * nothing checked here — and migration 0085 makes it IMPOSSIBLE, because `rights_request_guard` freezes
 * `due_at` and `sla_days` (ZA002) for exactly the reason the figure is stored per row in the first place.
 * A deadline a job may move is a deadline somebody may move, and then a request answered on day forty is
 * compliant. Keeping the original is also the stricter reading whenever the new figure is longer.
 *
 * The number is NOT presented as a statutory citation anywhere, and that is deliberate. The build has not
 * been given a deadline it can cite; it has been given a question. Thirty days is the figure the manifest
 * carries as provisional, and `rightsSlaProvenance` says so in the words the panel shows, so nobody reads
 * it as a figure somebody looked up.
 */
export const RIGHTS_SLA_DAYS_SETTING_KEY = 'privacy.rights_sla_days'
export const PROVISIONAL_RIGHTS_SLA_DAYS = 30
/** One day is the floor: a deadline of zero is a request that is overdue the moment it is taken. */
export const rightsSlaDaysSchema = z.number().int().min(1).max(90)

/**
 * Which supervisory authority a data subject complains to. **Deliberately absent, with no default.**
 *
 * This is the one field in the unit that is blank rather than provisional, and the difference is the
 * point. Every other unanswered question here has a strictest-safe answer the build can choose. This one
 * does not: `Y1-entity` decides whether the regulator is the federal one, DIFC's or ADGM's, and a
 * *plausible* regulator named in a letter to a data subject is indistinguishable from the right one —
 * it would send somebody with a genuine complaint to an office that cannot hear it, and it would be this
 * build's own invention. docs/04 §8 records the question as open ("whether registration with the UAE
 * Data Office applies") and nothing in the handover answers it.
 *
 * So the engine **performs** every right and **refuses to issue the written response document** while this
 * is unset, by name (`rights_response_authority_absent`). The work is done and visible; the letter that
 * would have to name a complaint route is not produced. A refusal a reader can see beats a document that
 * looks complete and misdirects.
 */
export const RIGHTS_SUPERVISORY_AUTHORITY_SETTING_KEY = 'privacy.supervisory_authority'
/**
 * The empty string, which is this repository's spelling of "deliberately blank".
 *
 * `google.cloud_quota_page_url` is blank the same way and for the weaker version of the same reason — a
 * URL written from memory opens the wrong project — so the shape is borrowed rather than invented.
 *
 * It is `''` and not `null` because `app_setting.value` is `jsonb not null`: a null default cannot be
 * SEEDED, and a setting with no row would not appear on the Unconfirmed Assumptions panel at all, which is
 * the one place this question has to be visible. That was found by the seeder refusing it (23502) rather
 * than by reasoning, and the refusal was right: a blank that nobody can see is not a blank, it is an
 * omission. `decideRightsResponse` treats an empty or whitespace value as absent, so a row of spaces
 * cannot pass for an answer either.
 *
 * The union rather than `.min(3)` alone is what lets the blank coexist with the validation: an authority
 * that IS named must be named properly, and the empty string is the one other permitted value.
 */
export const PROVISIONAL_SUPERVISORY_AUTHORITY = ''
export const rightsSupervisoryAuthoritySchema = z.union([z.literal(''), z.string().min(3).max(200)])

/**
 * Whether an erasure may destroy data a retention obligation covers.
 *
 * There is **no setting for this**, and that is worth stating where somebody will look for one:
 * `regulatory_profile.erasure_overrides_retention` (migration 0004) already holds it, defaults to
 * `false`, and is versioned so a past decision stays explainable. A second knob would be a second answer.
 * This constant exists only so a test can assert the two agree on the name.
 */
export const ERASURE_OVERRIDES_RETENTION_COLUMN = 'erasure_overrides_retention'

/** The open questions these settings carry, so a test asserts the pairing rather than a string. */
export const PRIVACY_OPEN_QUESTIONS = {
  entity: 'Y1-entity',
  residency: 'Y5-residency',
  licence: 'Y1-licence',
} as const

/**
 * What the Unconfirmed Assumptions panel says about the SLA, in the words it shows.
 *
 * A sentence and not a number, because the panel's job is to make a reader able to tell a figure the
 * build chose from a figure somebody confirmed, and a bare `30` cannot do that.
 */
export const RIGHTS_SLA_PROVENANCE =
  'Thirty days is the shortest deadline of the privacy regimes this build can see, chosen because the ' +
  'entity type (Y1-entity) that decides which regime applies has not been answered. It is not a ' +
  'statutory figure this build looked up, and it must not be quoted as one.'

/** The job that runs the per-class retention purge. */
export const RETENTION_PURGE_JOB = 'retention-purge'

/**
 * The outbox event an export covering more than one data subject publishes.
 *
 * docs/06 D4's insider-threat control: the realistic breach for this business is somebody exporting the
 * client list, not an external attacker. A single-subject export is a right being exercised; a
 * multi-subject one is a bulk read, and it alerts.
 */
export const RIGHTS_BULK_EXPORT_EVENT = 'privacy.bulk_export_alerted'
