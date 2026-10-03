import type { Sql } from '../connection.ts'

/**
 * `redirect_map`, read.
 *
 * The table is 0029's and is shared on purpose: B-CAT-05 writes a row when a service slug changes or a
 * service is archived, W-SITE-06 writes one when a therapist is renamed or retired, and W-SITE-09 imports
 * the legacy WooCommerce URLs into the same table. 0029's header states why there is one table rather than
 * three — *"two redirect tables would be two answers to 'where does this path go', resolved, if at all, by
 * whichever middleware ran first"* — and this module is the read side of that single answer.
 *
 * The one-hop and live-target invariants are the migration's, enforced by `redirect_map_one_hop` and by the
 * deferred trigger on `service`. Nothing here re-checks them: a reader that validated the row it just read
 * would be a second opinion about a rule the database already holds, and the day the two disagreed the
 * route would answer differently from the table.
 */

/** One row of the map, as a resolver reads it. */
export interface RedirectRow {
  readonly sourcePath: string
  readonly targetPath: string
  /** 301 or 308 — `redirect_map_status_permanent`. Never invented by a reader. */
  readonly statusCode: number
  readonly reason: string
}

/**
 * The redirect one path has, or undefined.
 *
 * Exact match on `source_path`, which is the unique key. A path is stored WITHOUT a trailing slash and in
 * lower case, because that is the only spelling `proxy.ts` lets through — `redirect_map_source_path_absolute`
 * refuses every other shape — so a caller normalises before asking rather than this query matching loosely.
 * A `lower()` or a slash-tolerant comparison here would silently serve a redirect for a URL the canonical
 * layer would have redirected first, which is the two-hop chain the whole table exists to avoid.
 */
export async function lookupRedirect(
  sql: Sql,
  sourcePath: string,
): Promise<RedirectRow | undefined> {
  const [row] = await sql<
    { source_path: string; target_path: string; status_code: number; reason: string }[]
  >`
    select source_path, target_path, status_code, reason
      from redirect_map where source_path = ${sourcePath}
  `
  return row === undefined
    ? undefined
    : {
        sourcePath: row.source_path,
        targetPath: row.target_path,
        statusCode: Number(row.status_code),
        reason: row.reason,
      }
}

/**
 * Every row, in source order.
 *
 * Read whole rather than paged, and the reason is what reads it: W-SITE-09's coverage gate and its one-hop
 * proof both ask questions about the map as a FUNCTION — no gaps, no chains, no loops — and a question about
 * a function cannot be answered from a page of its graph. The table holds the retired URLs of one small
 * site; if it ever stops being small, the gate's shape is what has to change, not its claim.
 */
export async function allRedirects(sql: Sql): Promise<readonly RedirectRow[]> {
  const rows = await sql<
    { source_path: string; target_path: string; status_code: number; reason: string }[]
  >`
    select source_path, target_path, status_code, reason from redirect_map order by source_path
  `
  return rows.map((row) => ({
    sourcePath: row.source_path,
    targetPath: row.target_path,
    statusCode: Number(row.status_code),
    reason: row.reason,
  }))
}
