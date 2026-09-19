import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The catalogue mutation chokepoint (B-CAT-05).
 *
 * The person who uses this is a non-technical owner on an admin screen, and every function here exists
 * because one obvious action in that screen would otherwise break something that is not visible from
 * it: deleting a service that a guest has already booked, renaming one that Google has indexed,
 * publishing one nothing can schedule, or typing a public name the licence does not permit.
 *
 * ## The guard rails are in the database; this module names them
 *
 * `0029_redirect.sql` carries the rules, because this repository is not the only thing that can reach
 * this schema — the CMS, a seed and a `psql` prompt all write `service`. What lives here is the
 * translation from a SQLSTATE into a refusal a caller can branch on, and the correct *sequence* for the
 * multi-statement mutations: a rename is "move the slug, retarget what pointed at the old path, insert
 * the 301", and the deferred trigger judges the transaction rather than any one of those statements.
 *
 * Two consequences worth stating, because both cost a debugging session otherwise:
 *
 *   - the slug and archive rules are **deferred**, so they fail at `COMMIT` — outside every function
 *     here, since the COMMIT belongs to `withUnitOfWork`. {@link catalogueError} is exported for a
 *     caller to wrap its own transaction, exactly as `journalError` is;
 *   - `delete from service` is refused by a foreign key two levels down (`appointment` →
 *     `service_variant` → `service`), so the SQLSTATE is a plain 23503 and the constraint name is what
 *     makes it mean "this service has been booked".
 *
 * ## Why the lint is injected rather than imported
 *
 * The banned-claims lexicon is `packages/core/src/compliance/lexicon.ts`, and `packages/db` must never
 * import `packages/core` — the dependency runs the other way. So {@link setPublicDisplayName} takes the
 * lint as a function and **refuses to write an unlinted public name at all**: fail closed, because the
 * plausible defect is a caller that forgot the lint, and an unlinted public name is indistinguishable
 * from a compliant one until an inspector reads it. {@link readCompliancePolicy} is the other half —
 * this module reads `regulatory_profile`, the caller feeds it to core's lint, and
 * `packages/fixtures/src/catalogue-compliance.itest.ts` exercises the pair.
 */

/**
 * The SQLSTATEs `0029_redirect.sql` raises.
 *
 * Class `ZC` is unused by PostgreSQL and reserved for user-defined conditions, like `ZL` in the ledger
 * and `ZB` in the booking schema. Custom codes rather than repurposed standard ones because a caller
 * has to tell these six apart, and the alternative is matching on message text — which stops working
 * the first time somebody improves the wording.
 */
export const CATALOGUE_SQLSTATE = {
  /** Publishing a service no room type may deliver. */
  publishWithoutCompatRow: 'ZC001',
  /** Publishing a service with no resource shape: nothing says how many therapists or rooms. */
  publishWithoutResourceShape: 'ZC002',
  /** Publishing a service with no priced duration. */
  publishWithoutPricedVariant: 'ZC003',
  /** A slug moved with no 301 from the old path. Raised at COMMIT. */
  slugChangeWithoutRedirect: 'ZC004',
  /** A redirect points at a path no live service answers on. Raised on write, and at COMMIT. */
  redirectTargetUnresolved: 'ZC005',
  /** A -> B -> C: the redirect would cost two hops. Collapse it to A -> C. */
  redirectChainNotCollapsed: 'ZC006',
  /** A redirect from a page that still answers. It can never fire; the live page wins. */
  redirectSourceStillLive: 'ZC007',
} as const

/** `23503`, foreign_key_violation. */
const FOREIGN_KEY_VIOLATION = '23503'
/** `23514`, check_violation. */
const CHECK_VIOLATION = '23514'

/**
 * The foreign key that refuses to let a booked service be deleted.
 *
 * `appointment.service_variant_id` is ON DELETE RESTRICT (0024) and `service_variant.service_id` is ON
 * DELETE CASCADE (0017), so deleting a service cascades into the variants and is refused by the
 * grandchild. PostgreSQL names the unnamed constraint `<table>_<column>_fkey`, and that name is the
 * only thing distinguishing this 23503 from any other.
 */
const APPOINTMENT_VARIANT_FK = 'appointment_service_variant_id_fkey'

/** The named domain refusals this module raises. A test asserts the name, never the sentence. */
export const CATALOGUE_REFUSALS = [
  'service_has_appointments',
  'service_publish_without_compat_row',
  'service_publish_without_resource_shape',
  'service_publish_without_priced_variant',
  'slug_change_without_redirect',
  'redirect_target_unresolved',
  'redirect_chain_not_collapsed',
  'redirect_source_still_live',
  'service_archived_is_not_published',
  'public_display_name_unlinted',
] as const
export type CatalogueRefusal = (typeof CATALOGUE_REFUSALS)[number]

/**
 * The public path of a service.
 *
 * The prefix is spelled here and in `treatment_path()` in 0029, because `packages/db` writes these
 * rows and the trigger validates them. Two spellings of one prefix is a redirect that silently stops
 * matching, so `catalogue.itest.ts` asserts the pair against each other rather than trusting them.
 */
export const SERVICE_PATH_PREFIX = '/treatments' as const
/** Where an archived service's page goes: the index, which always resolves. */
export const TREATMENTS_INDEX_PATH = '/treatments' as const

export function servicePath(slug: string): string {
  return `${SERVICE_PATH_PREFIX}/${slug}`
}

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/** The constraint a driver error names, from either spelling the drivers use. */
const constraintOf = (err: unknown): string | undefined => {
  const named = err as { constraint_name?: unknown; constraint?: unknown } | null
  if (typeof named?.constraint_name === 'string') return named.constraint_name
  if (typeof named?.constraint === 'string') return named.constraint
  const carried = (err as { details?: { constraint?: unknown } } | null)?.details?.constraint
  return typeof carried === 'string' ? carried : undefined
}

const refusal = (
  kind: 'conflict' | 'validation' | 'invariant_violated',
  name: CatalogueRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): AppError =>
  new AppError(kind, `${name}: ${message}`, {
    userFacing: true,
    details: { refusal: name, ...extra },
  })

/**
 * Translates a PostgreSQL error from the catalogue schema into a named `AppError`, or `null`.
 *
 * Exported for the same reason `journalError` is: the two rules that matter most here are deferred
 * constraint triggers, so they fail at `COMMIT`, which no function in this module executes.
 *
 * ```ts
 * try {
 *   await withUnitOfWork(sql, actor, (uow) => renameServiceSlug(uow, { serviceId, slug }))
 * } catch (err) {
 *   throw catalogueError(err) ?? err
 * }
 * ```
 *
 * The SQLSTATE decides, except for the two standard codes — 23503 and 23514 — where the constraint
 * name is what distinguishes this schema's refusal from any other foreign key or check in the database.
 * Anything unrecognised returns `null` and is rethrown by the caller: a translation that guessed would
 * report a disk error as a compliance refusal.
 */
export function catalogueError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  const sqlDetails = { sqlState: code, constraint: constraintOf(err) }
  switch (code) {
    case CATALOGUE_SQLSTATE.publishWithoutCompatRow:
      return refusal('conflict', 'service_publish_without_compat_row', message, sqlDetails)
    case CATALOGUE_SQLSTATE.publishWithoutResourceShape:
      return refusal('conflict', 'service_publish_without_resource_shape', message, sqlDetails)
    case CATALOGUE_SQLSTATE.publishWithoutPricedVariant:
      return refusal('conflict', 'service_publish_without_priced_variant', message, sqlDetails)
    case CATALOGUE_SQLSTATE.slugChangeWithoutRedirect:
      return refusal('invariant_violated', 'slug_change_without_redirect', message, sqlDetails)
    case CATALOGUE_SQLSTATE.redirectTargetUnresolved:
      return refusal('invariant_violated', 'redirect_target_unresolved', message, sqlDetails)
    case CATALOGUE_SQLSTATE.redirectChainNotCollapsed:
      return refusal('conflict', 'redirect_chain_not_collapsed', message, sqlDetails)
    case CATALOGUE_SQLSTATE.redirectSourceStillLive:
      return refusal('conflict', 'redirect_source_still_live', message, sqlDetails)
    case FOREIGN_KEY_VIOLATION:
      // Only this one foreign key. Every other 23503 in this schema means something else entirely,
      // and reporting it as "the service has appointments" would send the reader to the wrong table.
      return constraintOf(err) === APPOINTMENT_VARIANT_FK
        ? refusal(
            'conflict',
            'service_has_appointments',
            'the service has appointments booked against one of its durations, so the price that was ' +
              'quoted cannot be deleted out from under them. Archive it instead: it leaves the menu ' +
              'and availability, and the bookings keep what they were sold.',
            sqlDetails,
          )
        : null
    case CHECK_VIOLATION:
      return constraintOf(err) === 'service_archived_is_not_published'
        ? refusal(
            'conflict',
            'service_archived_is_not_published',
            'an archived service cannot stay published — the site would render a treatment the ' +
              'solver refuses to schedule. Archiving withdraws publication in the same statement.',
            sqlDetails,
          )
        : null
    default:
      return null
  }
}

/** The refusal an error carries, or `null`. Lets a caller branch without matching on the message. */
export function refusalOf(err: unknown): CatalogueRefusal | null {
  const translated = err instanceof AppError ? err : catalogueError(err)
  const name = translated?.details['refusal']
  return CATALOGUE_REFUSALS.includes(name as CatalogueRefusal) ? (name as CatalogueRefusal) : null
}

// ------------------------------------------------------------------------------------------------
// The compliance policy, as data
// ------------------------------------------------------------------------------------------------

/**
 * The licence-dependent half of the public-name lint, read from the profile in force.
 *
 * Structurally identical to `CompliancePolicy` in `@berelax/core`, and deliberately not that type:
 * `packages/db` may not import `packages/core`. The caller maps one to the other, which is a field
 * copy, and `packages/fixtures` exercises the pair.
 */
export interface CompliancePolicyRow {
  readonly bannedClaimTerms: readonly string[]
  readonly permittedPublicTitles: readonly string[]
  readonly medicalClaimsPermitted: boolean
  /** The profile version this came from, so an audit row can say which rules were applied. */
  readonly profileVersion: number
  /**
   * `regulatory_profile_current.licence_class` — `unconfirmed`, `wellness` or `healthcare`.
   *
   * Not part of the lint's own policy, which is why it is not on `CompliancePolicy` in `@berelax/core`.
   * It is here because a second consumer reads the same row for a different decision: W-SITE-03's JSON-LD
   * asks which schema.org types the licence permits (docs/09 §"Schema types" — `MedicalBusiness` and
   * `MedicalClinic` are refused unless the classification supports them), and that is the same question
   * `medical_claims_permitted` answers for a public *name*. Read from this function rather than through a
   * query of its own so the two decisions cannot be taken against two different profile versions.
   */
  readonly licenceClass: string
}

/**
 * Reads `regulatory_profile_current` — the view, never the table (0004).
 *
 * Throws when there is no profile in force. There is always one: 0004 seeds the stricter default
 * precisely so the system is never without it, so an empty result means the migration did not run or
 * somebody stamped `superseded_at` on every row. Defaulting to an empty banned list would be a lint
 * that silently permits everything, which is the one outcome worse than no lint.
 */
export async function readCompliancePolicy(sql: Sql): Promise<CompliancePolicyRow> {
  const [row] = await sql<
    {
      version: number
      banned_claim_terms: string[]
      permitted_public_titles: string[]
      medical_claims_permitted: boolean
      licence_class: string
    }[]
  >`
    select version, banned_claim_terms, permitted_public_titles, medical_claims_permitted,
           licence_class::text as licence_class
      from regulatory_profile_current
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'No regulatory profile is in force, so no public name can be linted. 0004 seeds one; an empty ' +
        'result means the profile was superseded without a replacement.',
    )
  }
  return {
    bannedClaimTerms: row.banned_claim_terms,
    permittedPublicTitles: row.permitted_public_titles,
    medicalClaimsPermitted: row.medical_claims_permitted,
    profileVersion: Number(row.version),
    licenceClass: row.licence_class,
  }
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

/** The audited shape of a service row: what a before/after pair holds. */
export interface ServiceSnapshot {
  readonly id: string
  readonly style: string
  readonly treatmentKey: string
  readonly slug: string
  readonly internalName: string
  readonly publicDisplayName: string
  readonly publishedAt: string | null
  readonly archivedAt: string | null
}

const SERVICE_COLUMNS = `
  id, style, treatment_key, slug, internal_name, public_display_name,
  published_at, archived_at
`

interface ServiceRow {
  id: string
  style: string
  treatment_key: string
  slug: string
  internal_name: string
  public_display_name: string
  published_at: Date | null
  archived_at: Date | null
}

const snapshot = (row: ServiceRow): ServiceSnapshot => ({
  id: row.id,
  style: row.style,
  treatmentKey: row.treatment_key,
  slug: row.slug,
  internalName: row.internal_name,
  publicDisplayName: row.public_display_name,
  publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
  archivedAt: row.archived_at === null ? null : row.archived_at.toISOString(),
})

/** One service, or `null`. Read inside the mutation's own transaction so `before` is the real row. */
export async function readService(sql: Sql, serviceId: string): Promise<ServiceSnapshot | null> {
  const rows = await sql<ServiceRow[]>`
    select ${sql.unsafe(SERVICE_COLUMNS)} from service where id = ${serviceId}
  `
  const row = rows[0]
  return row === undefined ? null : snapshot(row)
}

const mustRead = async (sql: Sql, serviceId: string): Promise<ServiceSnapshot> => {
  const found = await readService(sql, serviceId)
  if (found === null) {
    throw new AppError('not_found', `No service with id ${serviceId}`)
  }
  return found
}

/**
 * The services the public menu and the availability solver may offer.
 *
 * `published_at is not null and archived_at is null` is the one definition of bookable, and it is the
 * predicate of `service_bookable_idx` (0029) so this read is an index scan rather than a filter. An
 * archived service disappears from here the moment it is archived, which is what "removes it from
 * bookable availability" means — its existing appointments are untouched, because they hold a variant
 * and a snapshotted price, not a menu entry.
 */
export async function listBookableServices(sql: Sql): Promise<readonly ServiceSnapshot[]> {
  const rows = await sql<ServiceRow[]>`
    select ${sql.unsafe(SERVICE_COLUMNS)} from service
     where published_at is not null and archived_at is null
     order by display_order, id
  `
  return rows.map(snapshot)
}

/** What a public path resolves to. `redirect` carries the status the middleware must return. */
export type PathResolution =
  | { readonly kind: 'service'; readonly service: ServiceSnapshot }
  | { readonly kind: 'redirect'; readonly target: string; readonly status: number }
  | { readonly kind: 'not_found' }

/**
 * Resolves a public path: a live service, a redirect, or nothing.
 *
 * The order is the point. A slug that still resolves wins over a redirect that names it, because a
 * service renamed away and later renamed back would otherwise 301 to itself for ever. The redirect map
 * forbids a chain (0029), so what comes back here is always one hop.
 */
export async function resolveServicePath(sql: Sql, path: string): Promise<PathResolution> {
  const rows = await sql<ServiceRow[]>`
    select ${sql.unsafe(SERVICE_COLUMNS)} from service
     where slug = treatment_path_slug(${path}) and archived_at is null
  `
  const live = rows[0]
  if (live !== undefined) return { kind: 'service', service: snapshot(live) }

  const [redirected] = await sql<{ target_path: string; status_code: number }[]>`
    select target_path, status_code from redirect_map where source_path = ${path}
  `
  return redirected === undefined
    ? { kind: 'not_found' }
    : { kind: 'redirect', target: redirected.target_path, status: Number(redirected.status_code) }
}

// ------------------------------------------------------------------------------------------------
// Mutations
// ------------------------------------------------------------------------------------------------

/**
 * The lint, as a port.
 *
 * A function that throws when the name may not be published. `packages/db` cannot import the lexicon,
 * so the caller supplies `(name) => assertPublicDisplayNameCompliant(name, policy)` from
 * `@berelax/core`. Declared as a type rather than defaulted to a no-op on purpose: a default would be
 * a lint that permits everything, reached by every caller that forgot to pass one.
 */
export type PublicDisplayNameLint = (name: string) => void

/**
 * Runs the lint, refusing outright when none was supplied.
 *
 * Exported because the B-CAT-06 seed publishes the eight names 0017 inserted as drafts, and that write
 * is the moment they become public. A seed that skipped the lint would be the one write path on which a
 * non-compliant public name could reach the site — and the seed is the path nobody reviews twice.
 */
export const assertPublicDisplayNameLinted = (name: string, lint: PublicDisplayNameLint): void => {
  if (typeof lint !== 'function') {
    throw refusal(
      'invariant_violated',
      'public_display_name_unlinted',
      `no compliance lint was supplied for "${name}". A public name that has not been through the ` +
        'banned-claims lexicon is indistinguishable from a compliant one until somebody reads it on ' +
        'the site, so this write is refused rather than defaulted.',
    )
  }
  lint(name)
}

export interface SetPublicDisplayNameInput {
  readonly serviceId: string
  readonly publicDisplayName: string
  /** From `@berelax/core`; see {@link PublicDisplayNameLint}. Required, and checked at runtime. */
  readonly lint: PublicDisplayNameLint
}

/**
 * Renames the customer-facing name. The internal name is a different function on purpose.
 *
 * No redirect: the public name is not the URL. 0017 separated them so that renaming a treatment for a
 * customer does not silently move its page, and this is the half of that decision that shows up in
 * behaviour.
 */
export async function setPublicDisplayName(
  uow: UnitOfWork,
  input: SetPublicDisplayNameInput,
): Promise<ServiceSnapshot> {
  assertPublicDisplayNameLinted(input.publicDisplayName, input.lint)
  const before = await mustRead(uow.sql, input.serviceId)
  const [row] = await uow.sql<ServiceRow[]>`
    update service set public_display_name = ${input.publicDisplayName}
     where id = ${input.serviceId}
     returning ${uow.sql.unsafe(SERVICE_COLUMNS)}
  `
  const after = snapshot(row as ServiceRow)
  await uow.audit.record({
    action: 'catalogue.service.rename_public',
    entityType: 'service',
    entityId: input.serviceId,
    operation: 'update',
    before: { publicDisplayName: before.publicDisplayName },
    after: { publicDisplayName: after.publicDisplayName },
  })
  return after
}

/**
 * Sets the internal name. Unlinted, deliberately.
 *
 * The front desk calls a treatment whatever the front desk calls it, and the rota has to be readable at
 * 23:00. It is audited like every other mutation, so the asymmetry is recorded rather than assumed.
 */
export async function setInternalName(
  uow: UnitOfWork,
  input: { readonly serviceId: string; readonly internalName: string },
): Promise<ServiceSnapshot> {
  const before = await mustRead(uow.sql, input.serviceId)
  const [row] = await uow.sql<ServiceRow[]>`
    update service set internal_name = ${input.internalName}
     where id = ${input.serviceId}
     returning ${uow.sql.unsafe(SERVICE_COLUMNS)}
  `
  const after = snapshot(row as ServiceRow)
  await uow.audit.record({
    action: 'catalogue.service.rename_internal',
    entityType: 'service',
    entityId: input.serviceId,
    operation: 'update',
    before: { internalName: before.internalName },
    after: { internalName: after.internalName },
  })
  return after
}

export interface RenameSlugResult {
  readonly service: ServiceSnapshot
  readonly redirect: { readonly sourcePath: string; readonly targetPath: string }
  /** Redirects that pointed at the old path and were collapsed onto the new one. */
  readonly collapsed: readonly string[]
  /** Redirects FROM the new path, dropped because it answers for itself again. */
  readonly released: readonly string[]
}

/**
 * Moves a slug and leaves the 301 behind it, in one transaction.
 *
 * The order of the four statements is forced, and each of them is refused if it comes in a different
 * order:
 *
 *   1. **the slug moves first.** `redirect_map_one_hop` refuses a row whose target does not resolve, so
 *      a 301 written before the rename would point at a slug that does not exist yet.
 *   2. **then any redirect FROM the new path is released.** Renaming back to a slug the service used to
 *      have is the case: the old row pointed away from a path that now answers for itself, and a
 *      redirect from a live page can never fire (`ZC007`). It is deleted rather than retargeted —
 *      retargeting it onto the new path would be a redirect to itself.
 *   3. **then everything that pointed at the old path is retargeted.** Otherwise the new row's source
 *      is somebody else's target — a two-hop chain — and `ZC006` refuses it. This is the collapse
 *      W-SITE-09's importer inherits: A -> B followed by B -> C becomes A -> C, not a chain.
 *   4. **then the new 301.** `service_slug_change_keeps_redirects_honest` checks at COMMIT that it is
 *      there, and that it points at the slug the service actually ended the transaction with.
 */
export async function renameServiceSlug(
  uow: UnitOfWork,
  input: { readonly serviceId: string; readonly slug: string; readonly reason?: string },
): Promise<RenameSlugResult> {
  const before = await mustRead(uow.sql, input.serviceId)
  if (before.slug === input.slug) {
    throw new AppError(
      'validation',
      `Service ${input.serviceId} already has the slug "${input.slug}". A rename to the same slug ` +
        'would need a redirect from a path to itself, which is an infinite loop.',
    )
  }
  const oldPath = servicePath(before.slug)
  const newPath = servicePath(input.slug)
  const reason = input.reason ?? 'slug change'

  const [row] = await uow.sql<ServiceRow[]>`
    update service set slug = ${input.slug}
     where id = ${input.serviceId}
     returning ${uow.sql.unsafe(SERVICE_COLUMNS)}
  `
  const released = await uow.sql<{ target_path: string }[]>`
    delete from redirect_map where source_path = ${newPath} returning target_path
  `
  const collapsed = await uow.sql<{ source_path: string }[]>`
    update redirect_map set target_path = ${newPath}
     where target_path = ${oldPath}
     returning source_path
  `
  await uow.sql`
    insert into redirect_map (source_path, target_path, reason, created_by)
    values (${oldPath}, ${newPath}, ${reason}, ${'catalogue'})
  `
  const after = snapshot(row as ServiceRow)
  await uow.audit.record({
    action: 'catalogue.service.rename_slug',
    entityType: 'service',
    entityId: input.serviceId,
    operation: 'update',
    before: { slug: before.slug, path: oldPath },
    after: {
      slug: after.slug,
      path: newPath,
      redirect: { sourcePath: oldPath, targetPath: newPath, status: 301 },
      collapsed: collapsed.map((r) => r.source_path),
      released: released.map((r) => r.target_path),
    },
  })
  return {
    service: after,
    redirect: { sourcePath: oldPath, targetPath: newPath },
    collapsed: collapsed.map((r) => r.source_path),
    released: released.map((r) => r.target_path),
  }
}

/**
 * Takes a service off the menu without deleting anything.
 *
 * Three things happen together, and the third is the one that is easy to forget. Publication is
 * withdrawn in the same statement — `service_archived_is_not_published` refuses the alternative — and
 * every redirect pointing at the service's page is retargeted to the treatments index, because an
 * archived service's path 301s there (W-SITE-05) and a redirect to a redirect is two hops.
 *
 * The appointments are untouched. They hold a `service_variant` and a snapshotted gross, so a guest who
 * booked last week is still booked, at the price they were quoted.
 */
export async function archiveService(
  uow: UnitOfWork,
  input: { readonly serviceId: string; readonly reason?: string },
): Promise<{ readonly service: ServiceSnapshot; readonly retargeted: readonly string[] }> {
  const before = await mustRead(uow.sql, input.serviceId)
  const path = servicePath(before.slug)
  const retargeted = await uow.sql<{ source_path: string }[]>`
    update redirect_map
       set target_path = ${TREATMENTS_INDEX_PATH},
           reason      = ${input.reason ?? 'target service archived'}
     where target_path = ${path}
     returning source_path
  `
  const [row] = await uow.sql<ServiceRow[]>`
    update service set archived_at = now(), published_at = null
     where id = ${input.serviceId}
     returning ${uow.sql.unsafe(SERVICE_COLUMNS)}
  `
  const after = snapshot(row as ServiceRow)
  await uow.audit.record({
    action: 'catalogue.service.archive',
    entityType: 'service',
    entityId: input.serviceId,
    operation: 'update',
    before: { archivedAt: before.archivedAt, publishedAt: before.publishedAt, path },
    after: {
      archivedAt: after.archivedAt,
      publishedAt: after.publishedAt,
      retargeted: retargeted.map((r) => r.source_path),
    },
  })
  return { service: after, retargeted: retargeted.map((r) => r.source_path) }
}

/**
 * Publishes a service, or is refused for one of three named reasons.
 *
 * The three checks are in the database (0029) rather than here, so the CMS and a `psql` session meet
 * them too. What this adds is the audit row and the translation: a caller catches
 * `service_publish_without_priced_variant` and can say which of the three it was, which is the whole
 * difference between a useful admin message and "could not publish".
 */
export async function publishService(uow: UnitOfWork, serviceId: string): Promise<ServiceSnapshot> {
  const before = await mustRead(uow.sql, serviceId)
  let after: ServiceSnapshot
  try {
    const [row] = await uow.sql<ServiceRow[]>`
      update service set published_at = now()
       where id = ${serviceId}
       returning ${uow.sql.unsafe(SERVICE_COLUMNS)}
    `
    after = snapshot(row as ServiceRow)
  } catch (err) {
    throw catalogueError(err) ?? err
  }
  await uow.audit.record({
    action: 'catalogue.service.publish',
    entityType: 'service',
    entityId: serviceId,
    operation: 'update',
    before: { publishedAt: before.publishedAt },
    after: { publishedAt: after.publishedAt },
  })
  return after
}

/**
 * Deletes a service, and says why it could not be.
 *
 * Kept as a function precisely so the refusal has somewhere to live. The admin screen offers "delete"
 * because owners look for it; what they want is nearly always `archiveService`, and the one case where
 * delete is right — a service nobody ever booked — is worth supporting rather than forcing a
 * half-archived row nobody can remove.
 */
export async function deleteService(uow: UnitOfWork, serviceId: string): Promise<ServiceSnapshot> {
  const before = await mustRead(uow.sql, serviceId)
  try {
    await uow.sql`delete from service where id = ${serviceId}`
  } catch (err) {
    throw catalogueError(err) ?? err
  }
  await uow.audit.record({
    action: 'catalogue.service.delete',
    entityType: 'service',
    entityId: serviceId,
    operation: 'delete',
    before,
    after: null,
  })
  return before
}

export interface PriceChangeInput {
  readonly serviceVariantId: string
  readonly grossPriceFils: number
  readonly label: string
  /** ISO `YYYY-MM-DD`. The first day the new price applies. */
  readonly validFrom: string
  /** ISO `YYYY-MM-DD`, the **last** day it applies, or `null` for open-ended (0025). */
  readonly validTo?: string | null
}

export interface PriceChange {
  readonly priceListId: string
  readonly before: {
    readonly variantGrossPriceFils: number
    readonly effectivePriceListId: string | null
    readonly effectiveGrossPriceFils: number
  }
  readonly after: { readonly grossPriceFils: number; readonly validFrom: string }
}

/**
 * Changes a price by inserting a `price_list` row, never by UPDATE-ing one.
 *
 * `service_variant.gross_price_fils` is the catalogue's own figure and stays the fallback. Overwriting
 * it would rewrite what last month's bookings were worth (0025), and the appointments would keep their
 * snapshotted gross while every recomputed report disagreed with them. Effective-dated instead: the new
 * row states when the new price starts, `price_list_no_overlap` guarantees one answer per date, and
 * every appointment already taken is untouched — asserted over a seeded appointment in
 * `packages/fixtures/src/catalogue-compliance.itest.ts`.
 */
export async function changeVariantPrice(
  uow: UnitOfWork,
  input: PriceChangeInput,
): Promise<PriceChange> {
  const [variant] = await uow.sql<{ gross_price_fils: string; service_id: string }[]>`
    select gross_price_fils, service_id from service_variant where id = ${input.serviceVariantId}
  `
  if (variant === undefined) {
    throw new AppError('not_found', `No service_variant with id ${input.serviceVariantId}`)
  }
  // The price in force on the day the new one starts, by the same predicate 0025 documents and
  // `packages/core`'s resolver mirrors: valid_from <= day <= valid_to, both ends inclusive.
  const [effective] = await uow.sql<{ id: string; gross_price_fils: string }[]>`
    select id, gross_price_fils from price_list
     where service_variant_id = ${input.serviceVariantId}
       and valid_from <= ${input.validFrom}::date
       and (valid_to is null or ${input.validFrom}::date <= valid_to)
  `
  const [inserted] = await uow.sql<{ id: string }[]>`
    insert into price_list (service_variant_id, gross_price_fils, label, valid_from, valid_to)
    values (
      ${input.serviceVariantId}, ${input.grossPriceFils}, ${input.label},
      ${input.validFrom}::date, ${input.validTo ?? null}::date
    )
    returning id
  `
  const before = {
    variantGrossPriceFils: Number(variant.gross_price_fils),
    effectivePriceListId: effective?.id ?? null,
    effectiveGrossPriceFils:
      effective === undefined
        ? Number(variant.gross_price_fils)
        : Number(effective.gross_price_fils),
  }
  const after = { grossPriceFils: input.grossPriceFils, validFrom: input.validFrom }
  await uow.audit.record({
    action: 'catalogue.price.change',
    entityType: 'service_variant',
    entityId: input.serviceVariantId,
    operation: 'update',
    before,
    after: { ...after, priceListId: (inserted as { id: string }).id, label: input.label },
  })
  return { priceListId: (inserted as { id: string }).id, before, after }
}
