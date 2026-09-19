import type { Sql } from '../connection.ts'

/**
 * What the catalogue-derived routes need that the fact sheet does not carry: which pages exist, and when
 * each last changed.
 *
 * `readPremisesFacts` is and stays the only read of prices and names — the treatment page, `/pricing`, the
 * `Offer` JSON-LD and `/api/facts` all render from that one payload, which is what keeps them from
 * disagreeing. This adds the two things a *route* needs and a fact sheet has no field for:
 *
 *   - **the slug set**, for `generateStaticParams`. It is the same predicate (`published_at is not null and
 *     archived_at is null`), read on its own because the build needs 8 strings and not a 32-row price grid;
 *   - **`lastModified`**, for the sitemap's `lastmod` and for the publish loop's "did this page change?".
 *     Derived from `updated_at` on the three rows that can change what the page says — the service, its
 *     variants, and the `price_list` row in force — because a `lastmod` that moved on every deploy is one
 *     Google stops reading, and a `lastmod` that did not move when the price did is worse than none.
 *
 * Archived services are absent by the same predicate, which is what "an archived service leaves the
 * sitemap" means: there is no filter in the sitemap builder to forget.
 */

/** One catalogue-derived page. */
export interface TreatmentPageRow {
  readonly slug: string
  /** When anything the page publishes last changed, as an ISO instant. */
  readonly lastModified: string
  /** How many priced durations it renders. 4 for every seeded service; asserted, never assumed. */
  readonly variantCount: number
}

/**
 * Every treatment page the catalogue publishes, in menu order.
 *
 * Menu order (`display_order, id`) rather than alphabetical, so the sitemap and the index page enumerate
 * the treatments in the order docs/13 §4 prints them and a diff of either is empty rather than reordered.
 */
export async function readTreatmentPages(sql: Sql): Promise<readonly TreatmentPageRow[]> {
  const rows = await sql<{ slug: string; last_modified: Date; variant_count: string }[]>`
    select s.slug,
           -- greatest() ignores NULLs, so a service with no effective price_list row still gets a date.
           greatest(
             s.updated_at,
             max(v.updated_at),
             max((
               select p.updated_at from price_list p
                where p.service_variant_id = v.id
                  and p.valid_from <= current_date
                  and (p.valid_to is null or current_date <= p.valid_to)
                limit 1
             ))
           ) as last_modified,
           count(v.id) as variant_count
      from service s
      join service_variant v on v.service_id = s.id
     where s.published_at is not null and s.archived_at is null
     group by s.id, s.slug, s.display_order, s.updated_at
     order by s.display_order, s.id
  `
  return rows.map((row) => ({
    slug: row.slug,
    lastModified: new Date(row.last_modified).toISOString(),
    variantCount: Number(row.variant_count),
  }))
}

/**
 * The slug of every archived service, for the route that has to 301 it.
 *
 * `resolveServicePath` answers the archived case from `redirect_map` — `archiveService` writes the 301 to
 * the treatments index in the same transaction — so this is not on the request path. It exists for the
 * assertion that the two agree: a service archived before that row was written (there are none, and the
 * check costs one query in a test rather than a silent 404 on a page that used to rank).
 */
export async function readArchivedTreatmentSlugs(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ slug: string }[]>`
    select slug from service where archived_at is not null order by slug
  `
  return rows.map((row) => row.slug)
}
