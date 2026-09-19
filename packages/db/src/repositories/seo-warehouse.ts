import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The Search Console warehouse's writes (migration 0042).
 *
 * Four things happen here and each exists because of a failure that is otherwise silent.
 *
 * **1. The upsert proves it lost nothing.** `upsertGscDailyRows` sends a batch, asks the database how many
 * rows it affected, and refuses to report success unless the two agree. That check is the whole reason
 * this function is not one line of SQL at a call site: the obvious spelling is `on conflict do nothing`,
 * and with it a batch of 60,000 rows containing 20,000 duplicates writes 40,000 rows, returns no error,
 * and leaves a warehouse that is a third short with nothing anywhere saying so. `do update` plus a count
 * check turns that into a failure at the moment it happens.
 *
 * **2. The rare-query gap is never written.** `rare_query_clicks` is a GENERATED column, so the insert
 * below does not name it and PostgreSQL would refuse it if it did (SQLSTATE 428C9). The number therefore
 * cannot disagree with the two totals it is derived from.
 *
 * **3. The inspection rotation is claimed, not chosen.** `claimUrlInspectionBatch` selects and marks in
 * one statement with `for update skip locked`, so two overlapping runs cannot hand the same URL to Google
 * twice — and the day's ledger is incremented in the same transaction, so a retry spends the remainder of
 * the cap rather than a second full one.
 *
 * **4. No arithmetic.** Whether a run may take 2,000 URLs or 300 is `inspectionBudget` in
 * `@berelax/core`, and `packages/db` may not import `packages/core` — so the caller computes the budget
 * and hands the answer here. The database still refuses a `take` that would breach the cap
 * (`seo_url_inspection_run_stays_within_the_daily_cap`), which is what makes the pairing checkable rather
 * than trusted.
 */

export const GSC_UPSERT_LOST_ROWS = 'seo_gsc_upsert_lost_rows'
export const GSC_BATCH_HAS_DUPLICATE_DIMENSIONS = 'seo_gsc_batch_has_duplicate_dimensions'

/**
 * One warehouse row, as the adapter converts a Search Console row.
 *
 * `date` is Google's calendar date in UTC (`YYYY-MM-DD`) and not a trading date — migration 0042's header
 * carries the argument. `avgPositionCenti` is the average position × 100 as an integer.
 */
export interface GscDailyRow {
  readonly siteUrl: string
  readonly date: string
  readonly page: string
  readonly query: string
  readonly device: string
  readonly country: string
  readonly clicks: number
  readonly impressions: number
  readonly avgPositionCenti: number
}

/**
 * How many rows go in one statement.
 *
 * Nine columns per row, so 1,000 rows is 9,000 bind parameters — comfortably inside PostgreSQL's limit of
 * 65,535, which a 60,000-row night would otherwise exceed by a factor of eight. The chunk size is a
 * function of that limit and nothing else; it is not a tuning knob.
 */
const UPSERT_CHUNK_ROWS = 1000

/** One row the upsert affected, and whether this statement inserted it rather than updating it. */
interface AffectedRow {
  readonly inserted: boolean
}

export interface GscUpsertResult {
  /** Rows the database confirmed it wrote. Equal to the batch size or the write threw. */
  readonly written: number
  readonly inserted: number
  readonly updated: number
}

/**
 * Upserts warehouse rows, refusing to lose one.
 *
 * `on conflict … do update`, never `do nothing`. The re-fetch of a day already stored is the *normal*
 * case here (the last two to three days keep changing, so each day is fetched on seven consecutive
 * nights), so the conflicting row must be updated with the newer figures — and the count of affected rows
 * then equals the count sent, which is what makes a missing row detectable at all.
 *
 * A batch carrying the same dimension tuple twice is refused by PostgreSQL itself with
 * `cardinality_violation`: *ON CONFLICT DO UPDATE command cannot affect row a second time*. That refusal
 * is wanted and is re-thrown with an explanation, because a duplicate within one response means the
 * paging cursor read the same rows twice, and silently keeping one of the two would hide the paging bug
 * and store a day's clicks at half their value.
 */
export async function upsertGscDailyRows(
  sql: Sql,
  rows: readonly GscDailyRow[],
): Promise<GscUpsertResult> {
  if (rows.length === 0) return { written: 0, inserted: 0, updated: 0 }

  let inserted = 0
  let updated = 0
  for (let offset = 0; offset < rows.length; offset += UPSERT_CHUNK_ROWS) {
    const chunk = rows.slice(offset, offset + UPSERT_CHUNK_ROWS)
    const values = chunk.map((row) => ({
      site_url: row.siteUrl,
      date: row.date,
      page: row.page,
      query: row.query,
      device: row.device,
      country: row.country,
      clicks: row.clicks,
      impressions: row.impressions,
      avg_position_centi: row.avgPositionCenti,
    }))
    let affected: AffectedRow[]
    try {
      affected = (await sql`
        insert into seo_gsc_daily ${sql(
          values,
          'site_url',
          'date',
          'page',
          'query',
          'device',
          'country',
          'clicks',
          'impressions',
          'avg_position_centi',
        )}
        on conflict (site_url, date, page, query, device, country) do update
          set clicks = excluded.clicks,
              impressions = excluded.impressions,
              avg_position_centi = excluded.avg_position_centi
        -- xmax = 0 is true only for a row this statement INSERTED; a row it updated carries the
        -- transaction that locked it. It is how the two are told apart without a second query, and the
        -- split is what makes an idempotent re-run visible as "0 inserted, 60,000 updated" rather than as
        -- a number that could mean either.
        returning (xmax = 0) as inserted
      `) as unknown as AffectedRow[]
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === '21000') {
        throw new AppError(
          'invariant_violated',
          'A batch of Search Console rows carried the same (date, page, query, device, country) twice. ' +
            'Google returns each dimension tuple once, so a duplicate means the paging cursor read the ' +
            'same rows twice — and keeping one of the pair would store the day at less than its real ' +
            'value while reporting success.',
          { details: { reason: GSC_BATCH_HAS_DUPLICATE_DIMENSIONS, chunkSize: chunk.length } },
        )
      }
      throw error
    }
    if (affected.length !== chunk.length) {
      // The check that would have caught `do nothing`. A row the database did not affect is a row that is
      // not in the warehouse, and a writer that reported the batch size rather than the affected count
      // would be lying by exactly the number of rows it lost.
      throw new AppError(
        'invariant_violated',
        `The warehouse accepted ${affected.length} of ${chunk.length} rows in one batch. Every row must ` +
          'be either inserted or updated; a row that was neither has been silently discarded, which is ' +
          'the failure the dimension index and this count exist together to make impossible.',
        {
          details: {
            reason: GSC_UPSERT_LOST_ROWS,
            sent: chunk.length,
            affected: affected.length,
          },
        },
      )
    }
    for (const row of affected) {
      if (row.inserted) inserted += 1
      else updated += 1
    }
  }
  return { written: inserted + updated, inserted, updated }
}

export interface GscSnapshotInput {
  readonly siteUrl: string
  readonly windowStart: string
  readonly windowEnd: string
  readonly requestedAtIso: string
  readonly pagesFetched: number
  readonly rowLimit: number
  readonly lastStartRow: number
  readonly rowsPersisted: number
  readonly queryClicks: number
  readonly queryImpressions: number
  readonly pageClicks: number
  readonly pageImpressions: number
}

export interface GscSnapshotRow extends GscSnapshotInput {
  readonly snapshotId: string
  /** GENERATED in the database. Read back, never sent. */
  readonly rareQueryClicks: number
  readonly rareQueryImpressions: number
}

/**
 * Records one run's evidence, replacing the previous run of the same window.
 *
 * Note what is NOT in the column list: the two `rare_query_*` columns. They are generated, PostgreSQL
 * refuses an INSERT that supplies one, and the refusal is the guarantee that the withheld figure on the
 * owner's screen is the difference between the two totals stored beside it rather than a number some
 * other code path computed.
 */
export async function recordGscSnapshot(
  sql: Sql,
  input: GscSnapshotInput,
): Promise<GscSnapshotRow> {
  const [row] = (await sql`
    insert into seo_gsc_snapshot
      (site_url, window_start, window_end, requested_at, pages_fetched, row_limit, last_start_row,
       rows_persisted, query_clicks, query_impressions, page_clicks, page_impressions)
    values
      (${input.siteUrl}, ${input.windowStart}::date, ${input.windowEnd}::date,
       ${input.requestedAtIso}::timestamptz, ${input.pagesFetched}, ${input.rowLimit},
       ${input.lastStartRow}, ${input.rowsPersisted}, ${input.queryClicks},
       ${input.queryImpressions}, ${input.pageClicks}, ${input.pageImpressions})
    on conflict (site_url, window_start, window_end) do update
      set requested_at = excluded.requested_at,
          pages_fetched = excluded.pages_fetched,
          row_limit = excluded.row_limit,
          last_start_row = excluded.last_start_row,
          rows_persisted = excluded.rows_persisted,
          query_clicks = excluded.query_clicks,
          query_impressions = excluded.query_impressions,
          page_clicks = excluded.page_clicks,
          page_impressions = excluded.page_impressions
    returning id::text as snapshot_id,
              rare_query_clicks::text as rare_query_clicks,
              rare_query_impressions::text as rare_query_impressions
  `) as unknown as {
    snapshot_id: string
    rare_query_clicks: string
    rare_query_impressions: string
  }[]
  if (row === undefined) throw new AppError('invariant_violated', 'seo_gsc_snapshot wrote no row')
  return {
    ...input,
    snapshotId: row.snapshot_id,
    rareQueryClicks: Number(row.rare_query_clicks),
    rareQueryImpressions: Number(row.rare_query_impressions),
  }
}

/** The stored run for one window, or undefined. What the owner-facing sentence is rendered from. */
export async function readGscSnapshot(
  sql: Sql,
  where: { readonly siteUrl: string; readonly windowStart: string; readonly windowEnd: string },
): Promise<GscSnapshotRow | undefined> {
  const [row] = (await sql`
    select id::text as snapshot_id, site_url, window_start::text as window_start,
           window_end::text as window_end, requested_at, pages_fetched, row_limit, last_start_row,
           rows_persisted,
           query_clicks::text as query_clicks, query_impressions::text as query_impressions,
           page_clicks::text as page_clicks, page_impressions::text as page_impressions,
           rare_query_clicks::text as rare_query_clicks,
           rare_query_impressions::text as rare_query_impressions
    from seo_gsc_snapshot
    where site_url = ${where.siteUrl}
      and window_start = ${where.windowStart}::date
      and window_end = ${where.windowEnd}::date
  `) as unknown as Record<string, unknown>[]
  if (row === undefined) return undefined
  return {
    snapshotId: row['snapshot_id'] as string,
    siteUrl: row['site_url'] as string,
    windowStart: row['window_start'] as string,
    windowEnd: row['window_end'] as string,
    requestedAtIso: (row['requested_at'] as Date).toISOString(),
    pagesFetched: row['pages_fetched'] as number,
    rowLimit: row['row_limit'] as number,
    lastStartRow: row['last_start_row'] as number,
    rowsPersisted: row['rows_persisted'] as number,
    queryClicks: Number(row['query_clicks']),
    queryImpressions: Number(row['query_impressions']),
    pageClicks: Number(row['page_clicks']),
    pageImpressions: Number(row['page_impressions']),
    rareQueryClicks: Number(row['rare_query_clicks']),
    rareQueryImpressions: Number(row['rare_query_impressions']),
  }
}

/** How many warehouse rows one property holds, optionally within a window. For a report header. */
export async function countGscDailyRows(
  sql: Sql,
  where: { readonly siteUrl: string; readonly from?: string; readonly to?: string },
): Promise<number> {
  const [row] = (await sql`
    select count(*)::text as n from seo_gsc_daily
    where site_url = ${where.siteUrl}
      and (${where.from ?? null}::date is null or date >= ${where.from ?? null}::date)
      and (${where.to ?? null}::date is null or date <= ${where.to ?? null}::date)
  `) as unknown as { n: string }[]
  return Number(row?.n ?? '0')
}

// --- URL Inspection rotation -------------------------------------------------------------------

export interface InspectionCandidate {
  readonly url: string
  /** Lower sorts first. The tie-break after "least recently inspected". */
  readonly priority: number
}

/**
 * Registers the candidate set, updating the priority of one already known.
 *
 * `do update` on the priority rather than `do nothing`: the candidate list is derived from traffic, so a
 * page that gained clicks must be able to move up the rotation. What is deliberately NOT touched is
 * `last_inspected_at` — re-registering a candidate must never reset its place in the rotation, or a
 * nightly re-registration would make the rotation start from the beginning every night and the tail would
 * never be inspected at all.
 */
export async function registerInspectionCandidates(
  sql: Sql,
  args: { readonly siteUrl: string; readonly candidates: readonly InspectionCandidate[] },
): Promise<number> {
  if (args.candidates.length === 0) return 0
  let written = 0
  for (let offset = 0; offset < args.candidates.length; offset += UPSERT_CHUNK_ROWS) {
    const chunk = args.candidates.slice(offset, offset + UPSERT_CHUNK_ROWS)
    const values = chunk.map((candidate) => ({
      site_url: args.siteUrl,
      url: candidate.url,
      priority: candidate.priority,
    }))
    const affected = (await sql`
      insert into seo_url_inspection ${sql(values, 'site_url', 'url', 'priority')}
      on conflict (site_url, url) do update set priority = excluded.priority
      returning id::text as id
    `) as unknown as { id: string }[]
    written += affected.length
  }
  return written
}

export interface InspectionRunLedger {
  readonly siteUrl: string
  readonly runDate: string
  readonly dailyCap: number
  /** What this property has already spent today. The caller turns it into a budget. */
  readonly spentToday: number
}

/**
 * Opens (or re-reads) the day's quota ledger.
 *
 * The cap is per site per **Google day**, not per run: a job that retried after a partial failure and
 * spent a second full cap would burn the day's quota on work it had already done, and the URLs at the back
 * of the rotation would never be reached. So the ledger row is keyed on the date and every run reads what
 * the day has already spent before deciding how much it may take.
 */
export async function openInspectionRun(
  sql: Sql,
  args: { readonly siteUrl: string; readonly runDate: string; readonly dailyCap: number },
): Promise<InspectionRunLedger> {
  const [row] = (await sql`
    insert into seo_url_inspection_run (site_url, run_date, daily_cap)
    values (${args.siteUrl}, ${args.runDate}::date, ${args.dailyCap})
    on conflict (site_url, run_date) do update set daily_cap = excluded.daily_cap
    returning daily_cap, inspected
  `) as unknown as { daily_cap: number; inspected: number }[]
  if (row === undefined) {
    throw new AppError('invariant_violated', 'seo_url_inspection_run wrote no ledger row')
  }
  return {
    siteUrl: args.siteUrl,
    runDate: args.runDate,
    dailyCap: row.daily_cap,
    spentToday: row.inspected,
  }
}

export interface ClaimedInspection {
  readonly url: string
  /** Null for a URL never inspected. What makes "covered before re-inspected" checkable. */
  readonly previouslyInspectedAtIso: string | null
  readonly priority: number
}

/**
 * Claims the next `take` URLs of the rotation and marks them as inspected now.
 *
 * ## Why marking happens at claim time rather than after the call
 *
 * Google charges the quota for the **request**, not for a successful answer. A rotation that marked a URL
 * only after a successful inspection would re-claim every URL whose inspection failed, spend the quota on
 * it again, and — with a cap of 2,000 and 5,000 candidates — could spend an entire day re-requesting the
 * same failing URL. The column comment in 0042 says so where the column is defined.
 *
 * ## Why one statement, and why `for update skip locked`
 *
 * Two runs can overlap: a retry, a manual trigger, a redeploy mid-pass. A select followed by an update
 * would hand both runs the same 2,000 URLs, which spends 4,000 of a 2,000 cap and covers half as much as
 * it reports. `skip locked` makes the second run take the next rows instead, which is the whole point of
 * claiming rather than choosing.
 *
 * The ordering is `last_inspected_at asc nulls first, priority, url` — and NULLS FIRST is the coverage
 * guarantee: every candidate that has never been inspected sorts ahead of every candidate that has, so
 * full coverage always happens before any re-inspection. The remaining keys are a deterministic tie-break,
 * without which two runs with identical state could choose different subsets and the rotation would not be
 * reproducible.
 */
export async function claimUrlInspectionBatch(
  sql: Sql,
  args: {
    readonly siteUrl: string
    readonly runDate: string
    readonly nowIso: string
    readonly take: number
  },
): Promise<readonly ClaimedInspection[]> {
  if (args.take <= 0) return []
  return await sql.begin(async (tx) => {
    const claimed = (await tx`
      with picked as (
        select id, url, priority, last_inspected_at
        from seo_url_inspection
        where site_url = ${args.siteUrl}
        order by last_inspected_at asc nulls first, priority asc, url asc
        limit ${args.take}
        for update skip locked
      ), marked as (
        update seo_url_inspection target
        set last_inspected_at = ${args.nowIso}::timestamptz,
            inspections = target.inspections + 1
        from picked
        where target.id = picked.id
        returning target.url, picked.priority, picked.last_inspected_at as previous
      )
      select url, priority, previous from marked
      order by previous asc nulls first, priority asc, url asc
    `) as unknown as { url: string; priority: number; previous: Date | null }[]

    if (claimed.length > 0) {
      // In the same transaction as the claim, so a crash between the two cannot produce URLs that were
      // sent to Google and a ledger that says the quota was never spent. The CHECK
      // `seo_url_inspection_run_stays_within_the_daily_cap` refuses an increment past the cap, which is
      // what makes the caller's budget arithmetic checkable rather than merely trusted.
      await tx`
        update seo_url_inspection_run
        set inspected = inspected + ${claimed.length}
        where site_url = ${args.siteUrl} and run_date = ${args.runDate}::date
      `
    }
    return claimed.map((row) => ({
      url: row.url,
      priority: row.priority,
      previouslyInspectedAtIso: row.previous === null ? null : row.previous.toISOString(),
    }))
  })
}

export interface InspectionOutcome {
  readonly url: string
  readonly verdict: string
  readonly coverageState: string
  readonly lastCrawledAtIso: string | null
}

/**
 * Records what Google said about each inspected URL.
 *
 * Deliberately does not touch `last_inspected_at` or `inspections`: the claim already did, and a second
 * write here would move the rotation cursor forward for the successful URLs only — so a URL whose
 * inspection failed would sort ahead of everything again and be re-requested at the cost of a quota Google
 * has already charged.
 */
export async function recordInspectionOutcomes(
  sql: Sql,
  args: { readonly siteUrl: string; readonly outcomes: readonly InspectionOutcome[] },
): Promise<number> {
  if (args.outcomes.length === 0) return 0
  let written = 0
  for (let offset = 0; offset < args.outcomes.length; offset += UPSERT_CHUNK_ROWS) {
    const chunk = args.outcomes.slice(offset, offset + UPSERT_CHUNK_ROWS)
    // Four parallel arrays through `unnest` rather than a row-list helper, and that is a postgres.js fact
    // rather than a style choice: its multi-row helper builds an INSERT's column list and values, which is
    // not a shape a `from (values …)` clause accepts — it refuses the parameters outright. `unnest` of
    // typed arrays is the one form that expresses "update these rows from this set" in a single statement,
    // and a single statement is what keeps 2,000 outcomes from becoming 2,000 round trips.
    const affected = (await sql`
      update seo_url_inspection target
      set verdict = source.verdict,
          coverage_state = source.coverage_state,
          last_crawled_at = source.last_crawled_at
      from unnest(
        ${chunk.map((outcome) => outcome.url)}::text[],
        ${chunk.map((outcome) => outcome.verdict)}::text[],
        ${chunk.map((outcome) => outcome.coverageState)}::text[],
        ${chunk.map((outcome) => outcome.lastCrawledAtIso)}::timestamptz[]
      ) as source (url, verdict, coverage_state, last_crawled_at)
      where target.site_url = ${args.siteUrl} and target.url = source.url
      returning target.id::text as id
    `) as unknown as { id: string }[]
    written += affected.length
  }
  return written
}

export interface InspectionCoverage {
  readonly candidates: number
  readonly everInspected: number
  readonly neverInspected: number
}

/** The coverage of one property's rotation. `neverInspected` reaching zero is a completed cycle. */
export async function inspectionCoverage(sql: Sql, siteUrl: string): Promise<InspectionCoverage> {
  const [row] = (await sql`
    select count(*)::text as candidates,
           count(last_inspected_at)::text as ever_inspected
    from seo_url_inspection
    where site_url = ${siteUrl}
  `) as unknown as { candidates: string; ever_inspected: string }[]
  const candidates = Number(row?.candidates ?? '0')
  const everInspected = Number(row?.ever_inspected ?? '0')
  return { candidates, everInspected, neverInspected: candidates - everInspected }
}
