/**
 * Publishing, renaming and retiring a therapist: the one door, and the redirect that cannot be forgotten.
 *
 * A therapist page names a real person. ADR 0020 therefore makes publication a **refusal** rather than a
 * flag — a display name an admin set and a photography consent somebody recorded, both or neither — and
 * migration 0050 made `employee.is_publishable` a GENERATED column so that the flag cannot be set by a
 * screen that filled in one of them. This module is the write side of that: the only place in the build
 * that writes `employee.display_name`, `employee.photo_consent` or `employee.public_slug`.
 *
 * ## Why it is in `packages/hr` and not in `packages/db`
 *
 * The slug is `therapistSlug()` in `@berelax/core`, and `packages/db` may never import `packages/core` —
 * the dependency runs the other way (brief rule 4). `packages/hr` is the layer that already exists for
 * exactly this: *"the arithmetic is `@berelax/core`'s and the rows are `@berelax/db`'s, and that package
 * may not import the first"* (`packages/hr/src/index.ts`). So the rule lives in core, the rows live in db,
 * and the one function that applies the rule to the rows lives here. The alternative — a `db` repository
 * taking a pre-computed slug — was rejected because a caller could then pass any string that matched
 * `employee_public_slug_shape`, which is a chokepoint with a hole in it.
 *
 * ## Why a rename writes a redirect and an archival writes a redirect
 *
 * Both retire a URL, and docs/09 §2 is explicit about the second: *"A therapist leaves and their page has
 * inbound links, accumulated reviews and rankings. Do **not** 404 it."* The redirect is written in the
 * SAME transaction as the change, which is 0029's rule for a service slug and the same rule here — except
 * that 0029 needed a deferred TRIGGER to enforce it, because the CMS, the seed and a psql session all
 * write `service`. Nothing but this module writes a display name, and
 * `apps/web/src/therapist-guard.test.ts` is the scan that keeps that true.
 *
 * `redirect_map`'s own `redirect_map_one_hop` trigger (0029) then does the rest: a therapist renamed twice
 * cannot leave a chain, because the second rename's row would point at a path that is itself a source and
 * the trigger refuses it — so this module retargets instead, which is the collapse to A → C.
 */
import { isTherapistPublishable, therapistSlug } from '@berelax/core'
import {
  type Actor,
  AuditWriter,
  type Sql,
  THERAPIST_INDEX_PATH,
  therapistPathFor,
} from '@berelax/db'
import { AppError } from '@berelax/shared'

/*
  The two path helpers are `@berelax/db`'s, beside `TREATMENTS_INDEX_PATH` and `servicePath()`: that package
  writes the `redirect_map` rows, so it is where the `/therapists` prefix is spelled.
  `apps/web/src/therapists/paths.test.ts` asserts them against the route registry's own entries.
*/
export { THERAPIST_INDEX_PATH, therapistPathFor }

export interface PublishTherapistInput {
  readonly employeeId: string
  /** The name the admin typed. Linted and slugged here; never invented (brief rule 15). */
  readonly displayName: string
  /** Who recorded the photography consent. 0050 refuses a consent with no recorder. */
  readonly photoConsentRecordedBy: string
  /** When it was recorded. Passed in rather than read from a clock, so a backdated record is possible. */
  readonly photoConsentRecordedAt: Date
  readonly actor: Actor
}

export interface TherapistPublicationResult {
  readonly staffReference: string
  readonly publicSlug: string
  /** The path that now 301s here, when a rename retired one. */
  readonly retiredPath: string | null
  readonly isPublishable: boolean
}

/** The row this module reads back after every write, so the generated column is never assumed. */
interface EmployeePublicationRow {
  readonly staff_reference: string
  readonly display_name: string | null
  readonly public_slug: string | null
  readonly photo_consent: boolean
  readonly photo_consent_recorded_at: Date | null
  readonly is_publishable: boolean
  readonly employed_until: Date | null
}

async function employeeRow(sql: Sql, employeeId: string): Promise<EmployeePublicationRow> {
  const [row] = await sql<EmployeePublicationRow[]>`
    select staff_reference, display_name, public_slug, photo_consent, photo_consent_recorded_at,
           is_publishable, employed_until
      from employee where id = ${employeeId}::uuid
  `
  if (row === undefined) {
    throw new AppError('not_found', `No employee ${employeeId}`, {
      details: { rule: 'therapist_publication_needs_a_row' },
    })
  }
  return row
}

/**
 * Set a display name and record a photography consent, in one transaction, and move the URL if it moved.
 *
 * Both halves together, because that is what ADR 0020 means. A function that set the name and left the
 * consent to a second call would make the intermediate state — a named therapist with no consent — a state
 * a screen can leave the database in, and `is_publishable` would be false with nothing saying why.
 *
 * Idempotent in the sense that matters: publishing the same name twice writes the same row and leaves no
 * redirect, because `redirect_map_not_self` would refuse `/therapists/x → /therapists/x` and the rename
 * branch is skipped when the slug has not moved.
 */
export async function publishTherapist(
  sql: Sql,
  input: PublishTherapistInput,
): Promise<TherapistPublicationResult> {
  const slug = therapistSlug(input.displayName)
  return await sql.begin(async (tx) => {
    const before = await employeeRow(tx as unknown as Sql, input.employeeId)
    const previousSlug = before.public_slug
    await tx`
      update employee
         set display_name = ${input.displayName},
             public_slug = ${slug},
             photo_consent = true,
             photo_consent_recorded_at = ${input.photoConsentRecordedAt},
             photo_consent_recorded_by = ${input.photoConsentRecordedBy},
             updated_at = now()
       where id = ${input.employeeId}::uuid
    `
    let retiredPath: string | null = null
    if (previousSlug !== null && previousSlug !== slug) {
      retiredPath = therapistPathFor(previousSlug)
      // Retarget first, then insert. A row already pointing at the OLD path would become a chain the
      // moment this row exists, and `redirect_map_one_hop` refuses it — correctly, which is why the
      // collapse happens here instead of being left for a crawler to discover.
      await tx`
        update redirect_map
           set target_path = ${therapistPathFor(slug)}, updated_at = now()
         where target_path = ${retiredPath}
      `
      await tx`
        insert into redirect_map (source_path, target_path, status_code, reason, created_by)
        values (${retiredPath}, ${therapistPathFor(slug)}, 301, 'therapist display name changed',
                ${input.actor.label ?? input.actor.kind})
      `
    }
    const after = await employeeRow(tx as unknown as Sql, input.employeeId)
    await new AuditWriter(tx as unknown as Sql, input.actor).record({
      action: 'therapist.publish',
      entityType: 'employee',
      entityId: input.employeeId,
      operation: 'update',
      // The internal handle and the publication state, never the name: an audit row is read by whoever is
      // investigating, and a trail that reprints a person's name on every change is a second copy of it
      // in an append-only table nobody can redact.
      before: { staffReference: before.staff_reference, isPublishable: before.is_publishable },
      after: {
        staffReference: after.staff_reference,
        isPublishable: after.is_publishable,
        publicSlug: after.public_slug,
        retiredPath,
      },
    })
    return {
      staffReference: after.staff_reference,
      publicSlug: slug,
      retiredPath,
      isPublishable: after.is_publishable,
    }
  })
}

export interface ArchiveTherapistInput {
  readonly employeeId: string
  /** The last day of employment. `employee_employment_period_ordered` refuses one before the start. */
  readonly employedUntil: string
  readonly actor: Actor
}

export interface TherapistArchivalResult {
  readonly staffReference: string
  /** The path that now 301s to the index, or null when the therapist had no published page. */
  readonly redirectedFrom: string | null
  readonly redirectTarget: string
}

/**
 * Retire a therapist: the page 301s to the index, and nothing 404s.
 *
 * The redirect is written only when there was a page to retire. A therapist who never had a display name
 * never had a URL, so a row from `/therapists/<nothing>` would be a redirect from a path that was never
 * indexed, never linked and never typed — dead weight in a table W-SITE-09's coverage gate walks, which is
 * the exact thing 0029's `redirect_source_still_live` refuses from the other direction.
 *
 * The display name and the consent are left ALONE. A departure is not a withdrawal of consent, the page
 * that 301s has to keep answering for a URL that ranks, and `therapistDisposition` is what reads the pair
 * of facts — retired plus publishable — as "redirect" rather than as "404".
 */
export async function archiveTherapist(
  sql: Sql,
  input: ArchiveTherapistInput,
): Promise<TherapistArchivalResult> {
  return await sql.begin(async (tx) => {
    const before = await employeeRow(tx as unknown as Sql, input.employeeId)
    await tx`
      update employee
         set employed_until = ${input.employedUntil}::date, updated_at = now()
       where id = ${input.employeeId}::uuid
    `
    const hadAPage =
      before.public_slug !== null &&
      isTherapistPublishable({
        staffReference: before.staff_reference,
        displayName: before.display_name,
        photographyConsentRecordedAt:
          before.photo_consent_recorded_at === null
            ? null
            : new Date(before.photo_consent_recorded_at).toISOString(),
        retiredAt: null,
      })
    let redirectedFrom: string | null = null
    if (hadAPage && before.public_slug !== null) {
      redirectedFrom = therapistPathFor(before.public_slug)
      // Anything pointing at this page now points at the index as well, which is the collapse: a therapist
      // renamed and then retired must leave ONE hop from the first URL, not two.
      await tx`
        update redirect_map
           set target_path = ${THERAPIST_INDEX_PATH},
               reason = 'therapist archived', updated_at = now()
         where target_path = ${redirectedFrom}
      `
      await tx`
        insert into redirect_map (source_path, target_path, status_code, reason, created_by)
        values (${redirectedFrom}, ${THERAPIST_INDEX_PATH}, 301, 'therapist archived',
                ${input.actor.label ?? input.actor.kind})
        on conflict (source_path) do update
          set target_path = ${THERAPIST_INDEX_PATH},
              reason = 'therapist archived',
              updated_at = now()
      `
    }
    await new AuditWriter(tx as unknown as Sql, input.actor).record({
      action: 'therapist.archive',
      entityType: 'employee',
      entityId: input.employeeId,
      operation: 'update',
      before: { staffReference: before.staff_reference, employedUntil: before.employed_until },
      after: {
        staffReference: before.staff_reference,
        employedUntil: input.employedUntil,
        redirectedFrom,
      },
    })
    return {
      staffReference: before.staff_reference,
      redirectedFrom,
      redirectTarget: THERAPIST_INDEX_PATH,
    }
  })
}
