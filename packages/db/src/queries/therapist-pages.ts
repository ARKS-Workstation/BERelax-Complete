import type { Sql } from '../connection.ts'

/**
 * What the therapist routes need and `readPublicTherapists` cannot answer: which therapist PAGES exist.
 *
 * Deliberately a second read beside `queries/public-roster.ts`, and the distinction is the same one that
 * file draws against `readEligibleTherapists`: three reads, three questions, three answers.
 *
 *   - `readEligibleTherapists` answers *who may take this appointment on this trading date* — credentials,
 *     skills, shifts and room compatibility. It excludes all nineteen today, because none has a credential
 *     row.
 *   - `readPublicTherapists` answers *who works here*, for the home page's photo grid. It is bounded by
 *     `employed_until >= current_date`, so somebody who has left is **absent** from it.
 *   - this answers *which URLs under `/therapists/` the site is responsible for*, which is the one question
 *     that must include the people who have left. docs/09 §2: *"A therapist leaves and their page has
 *     inbound links, accumulated reviews and rankings. Do **not** 404 it."* A read that stopped at the
 *     current roster would make a departure indistinguishable from a slug that never existed, and the
 *     route would 404 the URL instead of redirecting it.
 *
 * ## Why the publication guard is NOT in the `where` clause
 *
 * `employee.is_publishable` is GENERATED as `display_name is not null and photo_consent` (0050), and
 * filtering on it here would return the empty set today — so the therapist index would have no cards at
 * all, where docs/13 §8 states the launch state exactly: *"every therapist renders as an unlinked photo
 * card reading Name not yet published"*. The rows therefore come back with the flag and with
 * `employed_until`, and `isTherapistPublishable` in `@berelax/core` is what decides what each one earns.
 * One guard, three consumers, and `apps/web/src/therapist-guard.test.ts` asserts there is no second one.
 */

/**
 * The therapist index, and the one spelling of the `/therapists` prefix outside `apps/web`.
 *
 * Here beside `TREATMENTS_INDEX_PATH` and `servicePath()` for their reason: `packages/db` has to WRITE the
 * `redirect_map` rows a rename and an archival leave, so it has to be able to spell the path those rows
 * point at. `apps/web/src/therapists/paths.test.ts` asserts these two against the route registry's own
 * entries, because a second spelling of a prefix is a redirect that silently stops matching.
 */
export const THERAPIST_INDEX_PATH = '/therapists'

/** The public path of one therapist page. */
export function therapistPathFor(slug: string): string {
  return `${THERAPIST_INDEX_PATH}/${slug}`
}

/** One therapist, as the routes and the sitemap know them. */
export interface TherapistPageRow {
  /**
   * `employee.id`. What `/book?therapist=<id>` carries, which is why it is on this row at all.
   *
   * An opaque uuid rather than the slug or the staff reference, for the reason the booking flow already
   * gives: a preselected therapist is a row the solver filters on, and a slug would make the booking
   * endpoint resolve a public URL into a person — a second resolution path into `employee`, reachable with
   * a query parameter.
   */
  readonly id: string
  /** `Therapist 07` — the internal handle, and the only thing that tells two unnamed cards apart. */
  readonly staffReference: string
  /** NULL for all nineteen (`Y12-names`). Never rendered as a name when `isPublishable` is false. */
  readonly displayName: string | null
  /** NULL exactly when `displayName` is (0157's `employee_public_slug_with_display_name`). */
  readonly publicSlug: string | null
  /** The recorded act, not a tick: 0050 refuses `true` without a recorded at/by pair. */
  readonly photoConsent: boolean
  /** When the consent was recorded, as an ISO instant. NULL means none was. */
  readonly photoConsentRecordedAt: string | null
  /** GENERATED from the name and the consent. Nothing may write it, and nothing here tries. */
  readonly isPublishable: boolean
  /**
   * When employment ended, as an ISO instant, or NULL for open-ended employment.
   *
   * A `date` column rendered as an instant at midnight UTC, because `TherapistCandidate.retiredAt` is an
   * ISO string and a consumer comparing a date string with an instant string gets the wrong answer in
   * exactly one of the two zones. The guard only asks whether it is null.
   */
  readonly retiredAt: string | null
  /** `asian_style` / `arabic_style`, sorted. Provisional against `Y8-staff`; the rows say so. */
  readonly skills: readonly string[]
  /** `arabic` / `english`, sorted. Empty for all nineteen: docs/13 §5 publishes no languages. */
  readonly languages: readonly string[]
  /** When anything the page publishes last changed, as an ISO instant. The sitemap's `lastmod`. */
  readonly lastModified: string
}

/**
 * Every therapist the site is responsible for a URL for, in roster order.
 *
 * Roster order (`staff_reference`) rather than by name, because the index renders unnamed cards today and
 * ordering by a NULL display name would order nineteen cards arbitrarily — a diff of the page would be
 * noise on every deploy.
 *
 * `lastModified` is `greatest()` over the row and its skill and language rows, for the reason
 * `readTreatmentPages` gives: a `lastmod` that moves on every deploy is one Google stops reading, and a
 * `lastmod` that does not move when the page's content did is worse than none.
 */
export async function readTherapistPages(sql: Sql): Promise<readonly TherapistPageRow[]> {
  const rows = await sql<
    {
      id: string
      staff_reference: string
      display_name: string | null
      public_slug: string | null
      photo_consent: boolean
      photo_consent_recorded_at: Date | null
      is_publishable: boolean
      employed_until: Date | null
      skills: string[] | null
      languages: string[] | null
      last_modified: Date
    }[]
  >`
    select e.id,
           e.staff_reference,
           e.display_name,
           e.public_slug,
           e.photo_consent,
           e.photo_consent_recorded_at,
           e.is_publishable,
           e.employed_until,
           (select array_agg(s.skill::text order by s.skill)
              from employee_skill s where s.employee_id = e.id) as skills,
           (select array_agg(l.language::text order by l.language)
              from employee_language l where l.employee_id = e.id) as languages,
           -- greatest() ignores NULLs, so a therapist with no skill and no language row still gets a date.
           greatest(
             e.updated_at,
             (select max(s.created_at) from employee_skill s where s.employee_id = e.id),
             (select max(l.created_at) from employee_language l where l.employee_id = e.id)
           ) as last_modified
      from employee e
     order by e.staff_reference
  `
  return rows.map((row) => ({
    id: row.id,
    staffReference: row.staff_reference,
    displayName: row.display_name,
    publicSlug: row.public_slug,
    photoConsent: row.photo_consent,
    photoConsentRecordedAt:
      row.photo_consent_recorded_at === null
        ? null
        : new Date(row.photo_consent_recorded_at).toISOString(),
    isPublishable: row.is_publishable,
    retiredAt: row.employed_until === null ? null : new Date(row.employed_until).toISOString(),
    skills: row.skills ?? [],
    languages: row.languages ?? [],
    lastModified: new Date(row.last_modified).toISOString(),
  }))
}

/** One therapist by the slug their page answers on, or undefined. */
export async function readTherapistPageBySlug(
  sql: Sql,
  slug: string,
): Promise<TherapistPageRow | undefined> {
  // Read the whole roster and find the row rather than issuing `where public_slug = $1`, because the route
  // ALSO has to distinguish "no such therapist" from "a therapist whose page may not be published", and the
  // second needs the row. Nineteen rows: the index page reads the same list on the same request.
  const pages = await readTherapistPages(sql)
  return pages.find((page) => page.publicSlug === slug)
}

/**
 * Which skill each treatment style requires: `service_skill`, whole.
 *
 * Four rows at most and read whole, because the question it answers is a mapping and not a lookup: the
 * therapist page has to turn a therapist's SKILLS into the live services they may be published as knowing
 * about, and `service.style` is `asian` where `employee_skill.skill` is `asian_style`. The relation
 * between them is this table (ADR 0021), never a string transformation — a `${style}_style` would compile,
 * read naturally, and be wrong the first time a style is named anything else.
 */
export interface ServiceSkillRow {
  readonly style: string
  readonly requiredSkill: string
}

export async function readServiceSkills(sql: Sql): Promise<readonly ServiceSkillRow[]> {
  const rows = await sql<{ style: string; required_skill: string }[]>`
    select style::text as style, required_skill::text as required_skill
      from service_skill order by style
  `
  return rows.map((row) => ({ style: row.style, requiredSkill: row.required_skill }))
}
