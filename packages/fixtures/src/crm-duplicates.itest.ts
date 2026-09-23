import {
  classifyPhoneAgreement,
  crmPhoneKey,
  DUPLICATE_AUTO_MERGE_THRESHOLD,
  DUPLICATE_REVIEW_THRESHOLD,
  LABEL_PARTIAL_THRESHOLD,
  labelSimilarityPerMille,
  nameMatchKey,
  normaliseNameForMatching,
  normalisePhone,
  scoreDuplicatePair,
} from '@berelax/core'
import {
  createConnection,
  DUPLICATE_CANDIDATE_LIMIT,
  DUPLICATE_LABEL_SIMILARITY_FLOOR,
  DUPLICATE_PHONE_SIMILARITY_FLOOR,
  type DuplicateCandidateProbe,
  explainDuplicateCandidates,
  findDuplicateCandidates,
  type Sql,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { customerLabel, SYNTHETIC_MOBILE_PREFIX } from './synthetic.ts'

/**
 * C-CRM-02 — the candidate scan against a real PostgreSQL, and the two claims that span the boundary.
 *
 * `packages/fixtures` is the only package that may import both halves of this unit, and that is exactly
 * what this file is for. The scorer is pure and lives in `@berelax/core`; the scan is SQL and lives in
 * `@berelax/db`; neither package may import the other, so the rules that relate them can only be held
 * here. There are two, and both are the kind that fails silently:
 *
 *   1. **The two definitions of "similar" must agree.** The scan finds candidates with `pg_trgm`'s
 *      `similarity()` and the scorer measures labels with its own Jaccard over the same trigrams. If
 *      they disagreed, the database would hand up pairs the scorer dismisses — harmless — and withhold
 *      pairs the scorer would have merged, which is a duplicate nobody ever sees again. So the two are
 *      compared row by row over a table of label pairs, in both directions.
 *   2. **The scan's floors must be looser than the scorer's classes.** Every single-character mutation
 *      of a real nine-digit key is inserted and then looked for: if a floor rose above what a
 *      transposition measures, these assertions fail rather than the recall quietly dropping.
 *
 * ## The acceptance figures
 *
 * "The candidate query against a seeded 5,000-customer table returns in under 200 ms and EXPLAIN output
 * is asserted to contain a trigram index scan, not a sequential scan." Both are here, and the EXPLAIN is
 * taken of **the query the repository runs** (`explainDuplicateCandidates` builds it from the same
 * function `findDuplicateCandidates` does) rather than of a copy pasted into this file — a copy goes on
 * reporting an index scan long after the real query has started reading the whole table.
 *
 * The index assertion carries a control, because "the plan mentions an index" is satisfiable by accident:
 * the same predicate written in the one form a trigram index cannot answer — `similarity(...) >= floor`
 * with no `%` — is run beside it and asserted to produce the sequential scan. Without that, a plan that
 * had quietly stopped using the index would have to be noticed by a human reading a log.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind
 * (brief rule 12). Every row here carries {@link MARKER} in `customer.notes` and is deleted in
 * `afterAll`; nothing asserts a total on `customer`, and every claim about what the scan returned is a
 * claim about rows this file created — checked by id, not by count. The numbers are on the unallocated
 * `+971 59` prefix, which cannot ring a handset (`synthetic.ts`), and no row has a name: a customer with
 * no display name is labelled `Customer 0042` (ADR 0020), which is what the labels here are.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'ccrm02 duplicate candidates itest'

/** The acceptance figure, in milliseconds. */
const SCAN_BUDGET_MS = 200
const SEEDED_CUSTOMERS = 5_000
/**
 * Numbers are spread across the seven subscriber digits rather than run consecutively.
 *
 * `index * 7919 mod 9999999` is injective for this range (7919 is prime and shares no factor with
 * 9,999,999 = 3^2 x 239 x 4649), so 5,000 distinct numbers come out without a retry loop. Consecutive
 * numbers would be the wrong dataset to measure a trigram scan against: every row would be a near-miss
 * of its neighbour, and the scan would look far less selective than it is against a real table.
 */
const SPREAD = 7_919
const SPREAD_MODULUS = 9_999_999
/**
 * One row in four carries a label, and the ratio is a decision rather than a detail.
 *
 * What share of the real table will carry a display name is not known — no CRM has run yet, and no name
 * is ever invented for a customer (ADR 0020), so `display_name` is null until an admin types one. The
 * ratio here is chosen so that **both** branches of the scan have a population the planner will reach
 * for an index over: measured on this table, a label probe finds its candidates through
 * `customer_name_fold_trgm_idx` at one in four, one in two and one in one, and at one in twenty it goes
 * through 0019's partial btree instead — walking 253 named rows is genuinely cheaper than any index
 * lookup, which is a correct plan and not the one this unit is about. Neither ratio changes what the scan
 * RETURNS; the assertions below are about which index answers it.
 */
const NAMED_EVERY = 4

/** The record the probe is about: a walk-in the front desk is entering for the second time. */
const TWIN = `+971${SYNTHETIC_MOBILE_PREFIX}6000042`
/** How the desk typed it the second time. Normalises to {@link TWIN}; nothing stores this spelling. */
const TWIN_AS_TYPED = '059 600 0042'
const TWIN_LABEL = customerLabel(42)

/**
 * The second person on the handset, labelled in Arabic.
 *
 * `customerLabel(9999, 'ar')` and not `Customer 9999`: two English labels share the word `customer`,
 * which measures 0.5 and is `partial` rather than `different`. The Arabic label shares no trigram with
 * the English one, which is the case this assertion is about — and it is the realistic one, since the
 * desk labels an Arabic-speaking client in Arabic.
 */
const SHARED_HANDSET_LABEL = customerLabel(9_999, 'ar')

/** The near misses: one digit substituted, two digits transposed, one digit dropped. */
const ONE_DIGIT_APART = `+971${SYNTHETIC_MOBILE_PREFIX}6000043`
const TRANSPOSED = `+971${SYNTHETIC_MOBILE_PREFIX}6000024`
/** A stranger on the same operator block, to prove the scan discriminates rather than returning all. */
const STRANGER = `+971${SYNTHETIC_MOBILE_PREFIX}1975318`

let sql: Sql
const seededIds = new Map<string, string>()

const nationalKey = (e164: string): string => e164.replace(/\D/g, '').slice(-9)

const probeForTwin = (): DuplicateCandidateProbe => {
  const keyed = crmPhoneKey(TWIN_AS_TYPED)
  if (!keyed.ok) throw new Error(`the probe number did not key: ${keyed.reason}`)
  return {
    phoneMatchKey: keyed.matchKey,
    labelKey: normaliseNameForMatching(TWIN_LABEL),
  }
}

interface SeedRow {
  readonly phone_e164: string
  readonly display_name: string | null
  readonly name_match_key: string | null
  readonly locale: string
  readonly created_via: string
  readonly notes: string
}

const seedRow = (phone: string, label: string | null): SeedRow => ({
  phone_e164: phone,
  display_name: label,
  // Written by the application from `@berelax/core`, exactly as `ensureCustomer` does. 0019 states why
  // it is not a generated column: `unaccent` is STABLE, and a plpgsql copy of the folding would be a
  // second definition of one key.
  name_match_key: label === null ? null : nameMatchKey(label, normalisePhone(phone)),
  locale: 'en',
  created_via: 'import',
  notes: MARKER,
})

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  await sql`delete from customer where notes = ${MARKER}`

  const rows: SeedRow[] = []
  for (let index = 1; index <= SEEDED_CUSTOMERS; index += 1) {
    const subscriber = String((index * SPREAD) % SPREAD_MODULUS).padStart(7, '0')
    rows.push(
      seedRow(
        `+971${SYNTHETIC_MOBILE_PREFIX}${subscriber}`,
        index % NAMED_EVERY === 0 ? customerLabel(index) : null,
      ),
    )
  }
  for (const [phone, label] of [
    [TWIN, TWIN_LABEL],
    [ONE_DIGIT_APART, customelabelOrNull(43)],
    [TRANSPOSED, null],
    [STRANGER, customerLabel(5_318)],
  ] as const) {
    rows.push(seedRow(phone, label))
  }

  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500)
    const inserted = await sql<{ id: string; phone_e164: string }[]>`
      insert into customer ${sql(chunk as unknown as Record<string, unknown>[])}
      on conflict (phone_e164) do nothing
      returning id::text as id, phone_e164
    `
    for (const row of inserted) seededIds.set(row.phone_e164, row.id)
  }

  // Statistics, so the planner costs the rows that were just written rather than the table's old size.
  // Without this the EXPLAIN assertions would be about a table PostgreSQL believes is empty.
  await sql`analyze customer`
})

/** `Customer 0043`, or null. Declared as a function so the `as const` tuple above stays readable. */
function customelabelOrNull(index: number): string | null {
  return customerLabel(index)
}

afterAll(async () => {
  await sql`delete from customer where notes = ${MARKER}`
  // Leave the planner's statistics matching the table the next suite will see.
  await sql`analyze customer`
  await sql?.end({ timeout: 5 })
})

/** Every single-character edit of a nine-digit key. Substitutions, one transposition, one deletion. */
function singleCharacterEdits(key: string): readonly string[] {
  const edits: string[] = []
  for (let position = 0; position < key.length; position += 1) {
    for (const digit of '0123456789') {
      if (key[position] === digit) continue
      edits.push(`${key.slice(0, position)}${digit}${key.slice(position + 1)}`)
    }
    if (position + 1 < key.length && key[position] !== key[position + 1]) {
      edits.push(
        `${key.slice(0, position)}${key[position + 1]}${key[position]}${key.slice(position + 2)}`,
      )
    }
    edits.push(`${key.slice(0, position)}${key.slice(position + 1)}`)
  }
  return edits
}

/**
 * The edits of `key` that this system can still hold as a UAE mobile AND that the scorer calls a near
 * miss — which is exactly the set the candidate floor is responsible for finding.
 *
 * The filter is `classifyPhoneAgreement` itself rather than a rule restated here, and that is the point:
 * a dropped digit or a changed leading digit produces something `crmPhoneKey` refuses (nine digits
 * beginning with 5 is the shape), so the pair is `unknown`, an absent signal, and no floor applies. If
 * core's classification and this file's idea of it ever diverged, the corpus would silently shrink.
 */
function keyableNearMisses(key: string): readonly { key: string; mutation: string }[] {
  return singleCharacterEdits(key)
    .filter((mutation) => {
      const agreement = classifyPhoneAgreement(`+971${key}`, `+971${mutation}`)
      return agreement === 'one_digit_apart' || agreement === 'digits_transposed'
    })
    .map((mutation) => ({ key, mutation }))
}

describe('the seeded probe table', () => {
  it('holds the 5,000 customers the acceptance figure is measured against', () => {
    // A claim about the rows this file created, never a total on a shared table: earlier suites leave
    // customers behind and one that asserted `count(*)` would fail on somebody else's branch.
    expect(seededIds.size).toBe(SEEDED_CUSTOMERS + 4)
    expect(seededIds.get(TWIN)).toBeDefined()
    expect(seededIds.get(ONE_DIGIT_APART)).toBeDefined()
  })

  it('cannot hold the identical-number duplicate at all, which is the point of the unique index', async () => {
    // The strongest claim in the unit, and it belongs to 0019 rather than to this one: two customer rows
    // can never share an E.164, so the auto-merge band — reachable only with an identical number — can
    // contain at most one candidate however large the table grows. The scan exists for the classes the
    // unique index cannot catch.
    const again = await sql`
      insert into customer (phone_e164, locale, created_via, notes)
      values (${TWIN}, 'en', 'import', ${MARKER})
      on conflict (phone_e164) do nothing
      returning id
    `
    expect(again).toHaveLength(0)
    // The control: the same insert with a number nobody holds does create a row.
    const fresh = `+971${SYNTHETIC_MOBILE_PREFIX}6009999`
    const created = await sql<{ id: string }[]>`
      insert into customer (phone_e164, locale, created_via, notes)
      values (${fresh}, 'en', 'import', ${MARKER})
      on conflict (phone_e164) do nothing
      returning id::text as id
    `
    expect(created).toHaveLength(1)
    await sql`delete from customer where phone_e164 = ${fresh}`
  })
})

describe('the candidate scan', () => {
  it(`returns in under ${SCAN_BUDGET_MS} ms against ${SEEDED_CUSTOMERS} customers`, async () => {
    const probe = probeForTwin()
    // Warm up outside the sample: the first call in a process pays for the connection handshake and the
    // first plan, and neither happens again.
    await findDuplicateCandidates(sql, probe)

    const durations: number[] = []
    for (let run = 0; run < 20; run += 1) {
      const startedAt = performance.now()
      const found = await findDuplicateCandidates(sql, probe)
      durations.push(performance.now() - startedAt)
      expect(found.length).toBeGreaterThan(0)
    }
    const sorted = [...durations].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] as number
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] as number
    // Printed as well as asserted: a budget that passes says nothing about the headroom left, and the
    // first question anybody asks when it breaks is what it used to be.
    console.log(
      `[C-CRM-02] candidate scan over ${SEEDED_CUSTOMERS} customers — median ${median.toFixed(1)} ms, ` +
        `p95 ${p95.toFixed(1)} ms, budget ${SCAN_BUDGET_MS} ms`,
    )
    expect(p95).toBeLessThan(SCAN_BUDGET_MS)
  })

  it('finds the twin and every near miss of it, and does not return the whole table', async () => {
    const found = await findDuplicateCandidates(sql, probeForTwin())
    const byId = new Set(found.map((row) => row.customerId))
    for (const [label, phone] of [
      ['the exact twin', TWIN],
      ['one digit apart', ONE_DIGIT_APART],
      ['two digits transposed', TRANSPOSED],
    ] as const) {
      expect(byId.has(seededIds.get(phone) as string), `${label} (${phone}) is a candidate`).toBe(
        true,
      )
    }
    // The control in both directions: a stranger on the same operator block is NOT a candidate on the
    // phone branch, and the scan returns tens of rows rather than five thousand.
    const stranger = found.find((row) => row.customerId === seededIds.get(STRANGER))
    expect(stranger?.phoneSimilarity ?? 0).toBeLessThan(DUPLICATE_PHONE_SIMILARITY_FLOOR)
    // Twice the cap, because the cap is per SIGNAL: a label probe in this system matches every record
    // labelled `Customer NNNN` (they all share one word), and a shared cap let those crowd out the
    // transposed number above. `1,000` would be the wrong bound to assert here — what matters is that the
    // scan returns tens of rows out of five thousand, and that each signal got its own allowance.
    expect(found.length).toBeLessThanOrEqual(2 * DUPLICATE_CANDIDATE_LIMIT)
    expect(
      found.filter((row) => row.phoneSimilarity >= DUPLICATE_PHONE_SIMILARITY_FLOOR).length,
    ).toBeLessThanOrEqual(DUPLICATE_CANDIDATE_LIMIT)

    // Every row came back for a stated reason — one of the two branches cleared its floor. A scan that
    // had lost its `where` would satisfy the membership assertions above and fail this one.
    for (const row of found) {
      expect(
        row.phoneSimilarity >= DUPLICATE_PHONE_SIMILARITY_FLOOR ||
          row.labelSimilarity >= DUPLICATE_LABEL_SIMILARITY_FLOOR,
        `${row.phoneE164} cleared neither floor`,
      ).toBe(true)
    }
  })

  it('never returns the record being checked as its own duplicate', async () => {
    const probe = { ...probeForTwin(), excludeCustomerId: seededIds.get(TWIN) as string }
    const found = await findDuplicateCandidates(sql, probe)
    expect(found.map((row) => row.customerId)).not.toContain(seededIds.get(TWIN))
    // The control: without the exclusion the same scan does return it, so the assertion above is about
    // the exclusion and not about a scan that finds nothing.
    const unfiltered = await findDuplicateCandidates(sql, probeForTwin())
    expect(unfiltered.map((row) => row.customerId)).toContain(seededIds.get(TWIN))
  })

  it('orders by similarity and breaks ties on id, so a capped scan is repeatable', async () => {
    const probe = probeForTwin()
    const first = await findDuplicateCandidates(sql, probe, { limit: 5 })
    const second = await findDuplicateCandidates(sql, probe, { limit: 5 })
    expect(second.map((row) => row.customerId)).toEqual(first.map((row) => row.customerId))
    // The twin is the most similar thing in the table, so a cap cannot push it out.
    expect(first[0]?.customerId).toBe(seededIds.get(TWIN))
    const strengths = first.map((row) => Math.max(row.phoneSimilarity, row.labelSimilarity))
    expect([...strengths].sort((a, b) => b - a)).toEqual(strengths)
  })

  it('refuses a probe with no keys rather than reporting no duplicates', async () => {
    // The dangerous version of this is the permissive one: `similarity('', anything)` is 0 for every row,
    // so an empty probe would return an empty list — indistinguishable from a record that genuinely has
    // no duplicates.
    await expect(
      findDuplicateCandidates(sql, { phoneMatchKey: null, labelKey: null }),
    ).rejects.toThrow(/neither a phone match key nor a label key/)
    await expect(findDuplicateCandidates(sql, probeForTwin(), { phoneFloor: 0 })).rejects.toThrow(
      /fraction in \(0, 1]/,
    )
    // The control: a probe with one of the two keys is accepted.
    await expect(
      findDuplicateCandidates(sql, { phoneMatchKey: nationalKey(TWIN), labelKey: null }),
    ).resolves.toBeDefined()
  })
})

describe('the plan', () => {
  it('reads the trigram indexes and never the whole customer table', async () => {
    const plan = (await explainDuplicateCandidates(sql, probeForTwin())).join('\n')
    expect(plan, plan).toContain('customer_phone_match_key_trgm_idx')
    expect(plan, plan).toContain('customer_name_fold_trgm_idx')
    expect(plan, plan).not.toContain('Seq Scan on customer')
    console.log(`[C-CRM-02] candidate scan plan:\n${plan}`)
  })

  it('reads the phone index on its own when the record has no label', async () => {
    const plan = (
      await explainDuplicateCandidates(sql, { phoneMatchKey: nationalKey(TWIN), labelKey: null })
    ).join('\n')
    expect(plan, plan).toContain('customer_phone_match_key_trgm_idx')
    expect(plan, plan).not.toContain('Seq Scan on customer')
  })

  /**
   * The control, and the reason the two assertions above are not self-satisfying.
   *
   * `%` is the only operator a trigram index can answer. The same predicate written as
   * `similarity(...) >= floor` selects exactly the same rows and cannot use the index — so if the plan
   * assertions above passed for a reason other than the index, this one would pass too, and it must not.
   */
  it('falls back to a sequential scan without the operator the index can answer', async () => {
    const probe = probeForTwin()
    const plan = await sql<{ 'QUERY PLAN': string }[]>`
      explain (analyze, costs off, timing off, summary off)
      select id from customer
      where similarity(phone_match_key, ${probe.phoneMatchKey as string}) >= ${DUPLICATE_PHONE_SIMILARITY_FLOOR}
    `
    const text = plan.map((row) => row['QUERY PLAN']).join('\n')
    expect(text, text).toContain('Seq Scan on customer')
    expect(text, text).not.toContain('customer_phone_match_key_trgm_idx')
  })
})

describe('the two halves agree about what "similar" means', () => {
  /**
   * `pg_trgm.similarity` against `labelSimilarityPerMille`, over the label variations that occur.
   *
   * The scan blocks with one and the scorer decides with the other. A disagreement is not a rounding
   * question: the trigram extraction differs by a padding rule or the coefficient differs by using Dice
   * instead of Jaccard, and then a pair the scorer would have merged never reaches it.
   */
  it.each([
    ['Customer 0042', 'Customer 0042'],
    ['0042 customer', '0043 customer'],
    ['0042 customer', '0042 custumer'],
    ['0042 customer', '00042 customer'],
    ['0042 customer', 'customer'],
    ['0042 customer', '0042'],
    ['ab', 'ba'],
    ['596000042', '596000043'],
    ['596000042', '596000024'],
    ['596000042', '591975318'],
  ] as const)('agrees on %j against %j', async (left, right) => {
    const [row] = await sql<{ similarity: number }[]>`
      select similarity(${normaliseNameForMatching(left)}, ${normaliseNameForMatching(right)})
        as similarity
    `
    const postgres = Math.round(Number((row as { similarity: number }).similarity) * 1000)
    expect(labelSimilarityPerMille(left, right)).toBe(postgres)
  })

  it('discriminates, so the agreement above is not agreement on one number', async () => {
    // The control. Two implementations that both returned 1.0 would pass every row above.
    const measured = new Set(
      [
        labelSimilarityPerMille('0042 customer', '0042 customer'),
        labelSimilarityPerMille('0042 customer', '0043 customer'),
        labelSimilarityPerMille('0042 customer', '0042'),
      ].map((value) => value),
    )
    expect(measured.size).toBe(3)
    expect(measured).toContain(1_000)
  })

  it('keeps the phone floor below every near miss a UAE mobile can reach', async () => {
    // The rule that spans the boundary: the scan must never withhold a pair the scorer would call a near
    // miss. Asserted against PostgreSQL's own `similarity` and against `classifyPhoneAgreement` in core,
    // over every single-character edit of four keys — the twin's, and the three repetitive ones where the
    // worst case lives (`590000000` measures 0.333 for a substitution, `595077777` the same for a
    // transposition). A floor raised above those fails here rather than losing recall in silence.
    const pairs = [nationalKey(TWIN), '590000000', '595077777', '500000000'].flatMap(
      keyableNearMisses,
    )
    const rows = await sql<{ key: string; mutation: string; similarity: number }[]>`
      select key, mutation, similarity(key, mutation) as similarity
      from unnest(${sql.array(pairs.map((pair) => pair.key))}::text[],
                  ${sql.array(pairs.map((pair) => pair.mutation))}::text[]) as t(key, mutation)
    `
    expect(rows.length).toBe(pairs.length)
    const worst = rows.reduce(
      (lowest, row) => (Number(row.similarity) < Number(lowest.similarity) ? row : lowest),
      rows[0] as { key: string; mutation: string; similarity: number },
    )
    console.log(
      `[C-CRM-02] the worst of ${rows.length} keyable near misses is ${Number(worst.similarity).toFixed(3)} ` +
        `(${worst.key} against ${worst.mutation}); the phone floor is ${DUPLICATE_PHONE_SIMILARITY_FLOOR}`,
    )
    expect(Number(worst.similarity)).toBeGreaterThan(DUPLICATE_PHONE_SIMILARITY_FLOOR)
    // The control: the corpus must actually contain the hard cases, or this passes on easy ones. 0.333 is
    // the documented worst case, and it must be in here.
    expect(Number(worst.similarity)).toBeCloseTo(1 / 3, 3)
    // And the label floor is core's own `partial` boundary, so nothing the scorer would score above 0.02
    // is withheld by the label branch either.
    expect(DUPLICATE_LABEL_SIMILARITY_FLOOR).toBe(LABEL_PARTIAL_THRESHOLD / 1000)
  })

  /**
   * The edge of the design, pinned from both sides.
   *
   * A trigram floor cannot cover every single-character edit. Swapping the two LEADING digits of a number
   * whose remaining digits are identical moves nearly every trigram at once and measures 0.200 — below
   * the floor, so the scan does not offer that pair and the scorer never sees it. The repository's note on
   * {@link DUPLICATE_PHONE_SIMILARITY_FLOOR} explains why the answer is a deterministic half-key block
   * rather than a lower floor (0.20 admits 81 candidates per probe on average, past the per-signal cap,
   * so the guarantee would be nominal), and the manifest carries it as a NOTE against C-CRM-05.
   *
   * It is asserted rather than described because a documented limitation nobody tests is a limitation
   * that silently changes. This fails if the pathological case starts measuring differently, AND it fails
   * if somebody lowers the floor far enough to cover it without moving the note.
   */
  it('does not reach the pathological FOREIGN transposition, and says so in an assertion', async () => {
    const [row] = await sql<{ similarity: number }[]>`
      select similarity('590000000', '950000000') as similarity
    `
    const measured = Number((row as { similarity: number }).similarity)
    expect(measured).toBeCloseTo(0.2, 3)
    expect(measured).toBeLessThan(DUPLICATE_PHONE_SIMILARITY_FLOOR)
    // Foreign, and it can only be foreign: `+971950000000` is not a UAE mobile — nine digits beginning
    // with 9 — so `crmPhoneKey` refuses it and the pair never has a phone class at all. On a country code
    // with no such shape rule the same two numbers are a transposition, which is the case the floor misses.
    expect(
      scoreDuplicatePair(
        { phone: '+971590000000', label: null },
        { phone: '+971950000000', label: null },
      ).phone,
    ).toBe('unknown')
    const scored = scoreDuplicatePair(
      { phone: '+44590000000', label: null },
      { phone: '+44950000000', label: null },
    )
    // The control, and the reason this is a boundary rather than a bug: the SCORER classifies the pair
    // correctly the moment anything hands it over. It is the search that cannot find it, not the
    // judgement that cannot make it.
    expect(scored.phone).toBe('digits_transposed')
  })
})

describe('scan then score, which is how the pair is used', () => {
  it('auto-merges the twin and reviews the near misses, from the rows the database returned', async () => {
    const found = await findDuplicateCandidates(sql, probeForTwin())
    const subject = { phone: TWIN_AS_TYPED, label: TWIN_LABEL }
    const scored = found.map((candidate) => ({
      // Named `e164` rather than `phone`, because `DuplicateScore` already carries a `phone` — the
      // agreement class. The first version of this spread overwrote one with the other, and the
      // assertion below then compared a class name to a number.
      e164: candidate.phoneE164,
      ...scoreDuplicatePair(subject, {
        phone: candidate.phoneE164,
        label: candidate.displayName,
      }),
    }))

    const auto = scored.filter((row) => row.verdict === 'auto_merge')
    expect(auto.map((row) => row.e164)).toEqual([TWIN])
    expect(auto[0]?.score).toBeGreaterThanOrEqual(DUPLICATE_AUTO_MERGE_THRESHOLD)

    const oneDigit = scored.find((row) => row.e164 === ONE_DIGIT_APART)
    expect(oneDigit?.phone).toBe('one_digit_apart')
    expect(oneDigit?.verdict).toBe('distinct')
    const transposed = scored.find((row) => row.e164 === TRANSPOSED)
    expect(transposed?.phone).toBe('digits_transposed')
    expect(transposed?.verdict).toBe('distinct')

    // The point of the pairing, stated as an assertion: a candidate the SCAN returned is not a
    // duplicate. Every near miss here scores below the review threshold because its label disagrees or
    // is absent, which is the conservative asymmetry the table is built on.
    for (const row of scored) {
      if (row.e164 === TWIN) continue
      expect(
        row.score,
        `${row.e164} must not reach the review band on the number alone`,
      ).toBeLessThan(DUPLICATE_REVIEW_THRESHOLD)
    }
  })

  it('surfaces a shared handset for review and never merges it', async () => {
    // The pair that decided the `identical x different` cell: one number, two labels. It cannot be two
    // customer ROWS — `phone_e164` is unique — so it arrives as a probe about an existing record, which
    // is exactly what the front desk does when a second person books on a family phone.
    const found = await findDuplicateCandidates(sql, {
      phoneMatchKey: nationalKey(TWIN),
      labelKey: normaliseNameForMatching(SHARED_HANDSET_LABEL),
    })
    const twin = found.find((row) => row.customerId === seededIds.get(TWIN))
    expect(twin).toBeDefined()
    const scored = scoreDuplicatePair(
      { phone: TWIN, label: SHARED_HANDSET_LABEL },
      { phone: twin?.phoneE164 ?? null, label: twin?.displayName ?? null },
    )
    expect(scored.phone).toBe('identical')
    expect(scored.label).toBe('different')
    expect(scored.verdict).toBe('review')
    expect(scored.score).toBeLessThan(DUPLICATE_AUTO_MERGE_THRESHOLD)
  })
})
