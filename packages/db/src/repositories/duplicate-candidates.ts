import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The duplicate-candidate scan: the few customer rows worth scoring, out of all of them.
 *
 * C-CRM-02 has two halves and they are in different packages for the reason `pnpm boundaries` enforces.
 * The **decision** — how alike two records are, and whether that is enough to merge — is pure and lives
 * in `packages/core/src/crm/duplicate-score.ts`. The **search** is a question only the database can
 * answer quickly, and it lives here. `packages/db` may not import `packages/core`, so nothing in this
 * file scores anything: it returns rows and the similarities it measured, and the caller
 * (`packages/fixtures/src/crm-duplicates.itest.ts` today, C-CRM-05's review queue tomorrow) hands them
 * to the scorer.
 *
 * ## Why a candidate scan exists at all
 *
 * Scoring is cheap and comparing every row to every other row is not: 5,000 customers is 12.5 million
 * pairs, and the table only grows. So the database narrows the field with the two signals it can index —
 * trigram similarity of the phone digits and of the folded label — and the scorer then decides. This is
 * standard blocking, and the property that makes it safe is that the floors below are *looser* than the
 * scorer's own boundaries: a pair the scorer would call a duplicate is never withheld by the scan.
 *
 * ## The one threshold PostgreSQL insists on owning
 *
 * `%` is the only operator a trigram index can answer, and it compares against a single session setting,
 * `pg_trgm.similarity_threshold`. One statement therefore cannot ask for two different floors, and this
 * scan wants two: nine digits drawn from an alphabet of ten are all somewhat alike, so the phone floor
 * has to sit very low to catch a transposition, while a label floor that low would make every record
 * sharing one common word a candidate for every other.
 *
 * The resolution is that the session setting is the LOWER of the two — so the index never withholds a
 * row — and each branch of the `where` carries its own explicit `similarity() >= floor` recheck. A
 * looser index threshold can only add candidates the recheck then drops; it can never lose one. The
 * setting is written with `set_config(..., true)`, which is transaction-local, so the scan opens a
 * transaction: without `true` the value would leak onto the next statement that happened to reuse the
 * pooled connection, and a threshold silently in force elsewhere is a query whose results depend on who
 * ran before it.
 *
 * ## The EXPLAIN is part of the contract
 *
 * {@link explainDuplicateCandidates} runs **the same query** through `EXPLAIN (ANALYZE)` — the same
 * builder, not a copy of the SQL — because the acceptance criterion is that this scan uses the trigram
 * indexes rather than reading the table. A copy of the query in a test is a copy that goes on reporting
 * a bitmap index scan after the real one has started sequentially scanning.
 */

/** A folded label key, or a number, that the probe was built from. */
export interface DuplicateCandidateProbe {
  /**
   * The trailing nine digits of the number being checked — `phoneMatchKey` from `@berelax/core`.
   *
   * Null when the record has no number this system can key, which is an ordinary case: a walk-in
   * recorded with a landline has no phone key at all (`crmPhoneKey` says why by name).
   */
  readonly phoneMatchKey: string | null
  /**
   * The folded label WITHOUT its `:last-4` tail — `normaliseNameForMatching` from `@berelax/core`.
   *
   * Not `display_name`: the folding lower-cases, strips Latin accents, folds Arabic orthography and
   * sorts the words, and none of that happens in SQL (migration 0055 says why it cannot).
   */
  readonly labelKey: string | null
  /** The record being checked, which must not be its own candidate. */
  readonly excludeCustomerId?: string | null
}

export interface DuplicateCandidateOptions {
  /**
   * Rows each signal may contribute, most similar first. The scan can return up to twice this many.
   *
   * Per signal and not over the union: see {@link candidateQuery} for the duplicate that a shared cap
   * dropped.
   */
  readonly limit?: number
  readonly phoneFloor?: number
  readonly labelFloor?: number
}

export interface DuplicateCandidateRow {
  readonly customerId: string
  readonly phoneE164: string
  readonly phoneMatchKey: string
  readonly displayName: string | null
  readonly nameMatchKey: string | null
  /** Trigram similarity of the nine-digit keys, 0 when the probe carried no number. */
  readonly phoneSimilarity: number
  /** Trigram similarity of the folded labels, 0 when either side has none. */
  readonly labelSimilarity: number
}

/**
 * The floors, and the measurements they come from.
 *
 * A candidate floor wants one thing: never to withhold a pair the scorer would call a near miss. Nine
 * digits drawn from an alphabet of ten are all somewhat alike, so the intuition that a mistyped number
 * scores near 1.0 is wrong, and the real figures decide the floor. Measured over 2,000 keys from the
 * `+971 59` block plus eight deliberately repetitive ones, against every single-character edit of each
 * that the system can still hold as a UAE mobile:
 *
 *   * one digit substituted — worst **0.333** (`590000000` against `510000000`)
 *   * two digits transposed — worst **0.333** (`595077777` against `559077777`)
 *
 * Those are the only two near-miss classes a UAE number can reach at all, and the reason is B-LIFE-02's
 * shape rule rather than this scan's: a UAE national number is nine digits beginning with 5, so a dropped
 * digit or a changed leading digit produces something `crmPhoneKey` refuses to key — the pair is then
 * `unknown`, an absent signal, and no floor is involved. For a FOREIGN number no national shape applies
 * and the worst cases are lower: **0.250** for a substitution, **0.286** for a deletion, and **0.200** for
 * a transposition of the two leading digits of a number whose remaining digits are identical.
 *
 * In the other direction, two entirely unrelated keys from one operator block reach **0.667** — higher
 * than any of the figures above. The ranges overlap, which is the whole reason this is a *candidate* scan
 * and not a decision: trigram similarity cannot separate a typo from a stranger, and `packages/core`'s
 * scorer — which asks for exactly one substitution, one transposition or one deletion — can.
 *
 * So the floor is 0.30. It clears every near miss a UAE mobile can reach, and it is the loosest floor that
 * stays inside {@link DUPLICATE_CANDIDATE_LIMIT}: candidates admitted per probe against 5,000 rows are
 * **7.8 on average and 16 at worst at 0.30**, against 80 and 147 at 0.25 — past the cap, where the cap
 * would drop the weakest candidates anyway and any guarantee would be nominal.
 *
 * **What it does not clear, stated rather than hidden:** the foreign cases between 0.20 and 0.30. Lowering
 * the floor to reach them costs more candidates than the cap allows, so the right instrument is a
 * deterministic block rather than a similarity floor — any single edit to a nine-digit key leaves either
 * its first four or its last five digits untouched, so two expression btrees on `left(key, 4)` and
 * `right(key, 5)` find every one of them at no measurable cost. It is not built here because nothing in
 * this unit's acceptance list asks for it and C-CRM-05 owns the review queue those candidates would feed.
 * It is recorded as a `NOTE:` on C-CRM-02 in `build/manifest.yaml`, and
 * `packages/fixtures/src/crm-duplicates.itest.ts` pins the boundary from both sides so that this
 * paragraph cannot quietly become untrue.
 *
 * The label floor is 0.45, which is `LABEL_PARTIAL_THRESHOLD` in core expressed as a fraction. Below that
 * boundary the scorer calls two labels `different`, and a `different` label with no phone match scores
 * 0.02 — so a candidate withheld there could not have been surfaced by anything.
 *
 * Both are numbers here rather than imports because `packages/db` may not import `packages/core`.
 * `packages/fixtures/src/crm-duplicates.itest.ts` asserts the relationship across that boundary: it
 * generates every single-character edit of four keys, keeps the ones `classifyPhoneAgreement` calls a near
 * miss, and measures each with PostgreSQL's own `similarity` — so a floor raised above one of them fails
 * there rather than losing recall in silence. That is the only way a rule spanning two packages can be
 * held rather than hoped for.
 */
export const DUPLICATE_PHONE_SIMILARITY_FLOOR = 0.3
export const DUPLICATE_LABEL_SIMILARITY_FLOOR = 0.45

/**
 * The cap, PER SIGNAL, and why 50 is not arbitrary.
 *
 * A review queue is read by a human, so an uncapped scan is not useful even when it is fast. 50 is three
 * times the measured worst-case phone-candidate count for a 5,000-row table (7.8 on average and 16 at
 * worst, at the floor below), which is the margin that matters: a cap close to the expected count silently
 * drops the weakest-measuring candidates, and the weakest-measuring ones are the transpositions.
 *
 * It applies to each signal separately, so a scan can return up to twice this many rows. See
 * {@link candidateQuery} for the duplicate that was lost when the cap was applied to the union instead.
 */
export const DUPLICATE_CANDIDATE_LIMIT = 50

/** Refusals this module raises, as values. */
export const DUPLICATE_CANDIDATE_REFUSALS = [
  /** The probe carried neither a phone key nor a label key, so there is nothing to search on. */
  'probe_has_no_key',
  /** A floor outside (0, 1]. `%` compares against a similarity, and a similarity is a fraction. */
  'floor_out_of_range',
] as const
export type DuplicateCandidateRefusal = (typeof DUPLICATE_CANDIDATE_REFUSALS)[number]

function refuse(refusal: DuplicateCandidateRefusal, message: string): never {
  throw new AppError('validation', message, { details: { refusal } })
}

interface ResolvedProbe {
  readonly phoneMatchKey: string
  readonly labelKey: string
  readonly excludeCustomerId: string | null
  readonly phoneFloor: number
  readonly labelFloor: number
  readonly limit: number
  /** The session floor: the lower of the two, so the index withholds nothing. */
  readonly indexFloor: number
}

function resolve(
  probe: DuplicateCandidateProbe,
  options: DuplicateCandidateOptions,
): ResolvedProbe {
  const phoneFloor = options.phoneFloor ?? DUPLICATE_PHONE_SIMILARITY_FLOOR
  const labelFloor = options.labelFloor ?? DUPLICATE_LABEL_SIMILARITY_FLOOR
  for (const [name, floor] of [
    ['phoneFloor', phoneFloor],
    ['labelFloor', labelFloor],
  ] as const) {
    if (!(floor > 0 && floor <= 1)) {
      refuse(
        'floor_out_of_range',
        `[duplicate-candidates] ${name} is ${floor}; a trigram similarity floor is a fraction in (0, 1]. ` +
          'A floor of 0 matches every row in the table and a floor above 1 matches none, and neither is ' +
          'a search.',
      )
    }
  }
  const phoneMatchKey = probe.phoneMatchKey ?? ''
  const labelKey = probe.labelKey ?? ''
  if (phoneMatchKey.length === 0 && labelKey.length === 0) {
    // An empty probe would otherwise become `similarity('', anything)`, which is 0 for every row — a
    // query that returns nothing and looks exactly like a record with no duplicates. Refusing says
    // which of the two it was.
    refuse(
      'probe_has_no_key',
      '[duplicate-candidates] the probe carries neither a phone match key nor a label key. A record ' +
        'with no keyable number and no label has no candidates by construction, which is a different ' +
        'answer from "none were found" and must not be reported as one.',
    )
  }
  return {
    phoneMatchKey,
    labelKey,
    excludeCustomerId: probe.excludeCustomerId ?? null,
    phoneFloor,
    labelFloor,
    limit: options.limit ?? DUPLICATE_CANDIDATE_LIMIT,
    indexFloor: Math.min(phoneFloor, labelFloor),
  }
}

/**
 * The one definition of the scan. Both the read and the EXPLAIN build from this.
 *
 * `%` on each side is what reaches the trigram indexes 0055 creates
 * (`customer_phone_match_key_trgm_idx` and `customer_name_fold_trgm_idx`); the `similarity() >=` beside
 * it is the per-signal floor that the shared session threshold cannot express.
 *
 * ## Why the cap is PER SIGNAL rather than over the union
 *
 * This was one `or` with one `limit` first, and it dropped a real duplicate. The label signal in this
 * system is intrinsically unselective: no customer name is ever invented (ADR 0020), so most labels are
 * `Customer 0042`, and every one of them shares the word `customer` with every other — measured at 0.647
 * similarity, which is *higher* than the 0.5 a transposed pair of digits measures. So 250 label matches
 * sorted above the transposed number and a cap of 50 cut it off: a duplicate the scan could see, ranked
 * out by noise, with every assertion about the exact match still passing.
 *
 * A cap has to be per signal or the noisier signal starves the sharper one. Each branch therefore takes
 * its own `limit` rows, and the scan returns their union — up to twice the cap, which is the honest
 * consequence and is documented on {@link DUPLICATE_CANDIDATE_LIMIT}.
 *
 * The empty-string guards matter: a probe with no label must not match on the label branch, and
 * `similarity('', x)` is 0 rather than an error, so without the guard the branch would be evaluated over
 * the whole table to no purpose. PostgreSQL folds them to a constant, so an unused branch costs nothing.
 */
function candidateQuery(sql: Sql, probe: ResolvedProbe) {
  return sql`
    with by_phone as (
      select id,
             similarity(phone_match_key, ${probe.phoneMatchKey}) as phone_similarity,
             0::real                                             as label_similarity
      from customer
      where ${probe.phoneMatchKey} <> ''
        and phone_match_key % ${probe.phoneMatchKey}
        and similarity(phone_match_key, ${probe.phoneMatchKey}) >= ${probe.phoneFloor}
      order by similarity(phone_match_key, ${probe.phoneMatchKey}) desc, id asc
      limit ${probe.limit}
    ), by_label as (
      select id,
             0::real                                                          as phone_similarity,
             similarity(split_part(name_match_key, ':', 1), ${probe.labelKey}) as label_similarity
      from customer
      where ${probe.labelKey} <> ''
        and name_match_key is not null
        and split_part(name_match_key, ':', 1) % ${probe.labelKey}
        and similarity(split_part(name_match_key, ':', 1), ${probe.labelKey}) >= ${probe.labelFloor}
      order by similarity(split_part(name_match_key, ':', 1), ${probe.labelKey}) desc, id asc
      limit ${probe.limit}
    ), merged as (
      -- A row found by both signals is one candidate carrying both measurements, never two rows.
      select id, max(phone_similarity) as phone_similarity, max(label_similarity) as label_similarity
      from (select * from by_phone union all select * from by_label) as either_signal
      group by id
    )
    select
      c.id::text                as "customerId",
      c.phone_e164              as "phoneE164",
      c.phone_match_key         as "phoneMatchKey",
      c.display_name            as "displayName",
      c.name_match_key          as "nameMatchKey",
      m.phone_similarity        as "phoneSimilarity",
      m.label_similarity        as "labelSimilarity"
    from merged m
    join customer c on c.id = m.id
    where ${probe.excludeCustomerId}::uuid is null or c.id <> ${probe.excludeCustomerId}::uuid
    order by greatest(m.phone_similarity, m.label_similarity) desc, c.id asc
  `
}

/**
 * The rows worth scoring against this probe, most similar first.
 *
 * The tie-break on `id` is not decoration: two candidates of equal similarity must come back in the same
 * order every time, or a capped scan returns a different set on two identical calls and a reviewer sees
 * a queue that shuffles itself.
 */
export async function findDuplicateCandidates(
  sql: Sql,
  probe: DuplicateCandidateProbe,
  options: DuplicateCandidateOptions = {},
): Promise<readonly DuplicateCandidateRow[]> {
  const resolved = resolve(probe, options)
  return await sql.begin(async (tx) => {
    await tx`select set_config('pg_trgm.similarity_threshold', ${String(resolved.indexFloor)}, true)`
    const rows = await candidateQuery(tx as unknown as Sql, resolved)
    return rows.map((row) => ({
      customerId: row['customerId'] as string,
      phoneE164: row['phoneE164'] as string,
      phoneMatchKey: row['phoneMatchKey'] as string,
      displayName: (row['displayName'] ?? null) as string | null,
      nameMatchKey: (row['nameMatchKey'] ?? null) as string | null,
      phoneSimilarity: Number(row['phoneSimilarity']),
      labelSimilarity: Number(row['labelSimilarity']),
    }))
  })
}

/**
 * `EXPLAIN (ANALYZE)` of the query {@link findDuplicateCandidates} runs, as lines.
 *
 * Exported because "this scan uses the trigram index rather than reading the table" is an acceptance
 * criterion, and the only honest way to assert it is to ask the planner about the real query. A test
 * that pasted the SQL in would be asserting something about its own copy.
 */
export async function explainDuplicateCandidates(
  sql: Sql,
  probe: DuplicateCandidateProbe,
  options: DuplicateCandidateOptions = {},
): Promise<readonly string[]> {
  const resolved = resolve(probe, options)
  return await sql.begin(async (tx) => {
    await tx`select set_config('pg_trgm.similarity_threshold', ${String(resolved.indexFloor)}, true)`
    const plan =
      await tx`explain (analyze, verbose off, costs off, timing off, summary off) ${candidateQuery(
        tx as unknown as Sql,
        resolved,
      )}`
    return plan.map((row) => String(row['QUERY PLAN']))
  })
}
