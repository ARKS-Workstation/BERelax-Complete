import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'

/**
 * G-REV-01 — the review shape, asked of a real PostgreSQL.
 *
 * Every claim in this file is a claim about the *shipped* schema, so every one of them is checked by
 * introspecting the applied migration and then attempting the thing it forbids. Reading
 * `0020_reviews.sql` and agreeing with it proves nothing: the column could be nullable in the file and
 * NOT NULL in the database that a half-applied migration left behind, and the assertion that matters —
 * "a pasted review with no id inserts" — is only true of a running database.
 *
 * The reviewer names here are Google's own placeholder for an anonymous reviewer ('A Google user',
 * which is what the real API returns and what `REVIEW_FIXTURES` carries) and record labels. No
 * invented person: a plausible fake name gets pasted into a ticket and eventually believed.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

/** Google's placeholder for a reviewer who left no name. Most star-only reviews arrive like this. */
const ANONYMOUS = 'A Google user'
const PLACE_A = 'ChIJ_place_a_fixture'
const PLACE_B = 'ChIJ_place_b_fixture'
const CT = Buffer.from('ciphertext-stand-in')

beforeAll(() => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  // Reviews first: the foreign key is ON DELETE RESTRICT on purpose, so a leftover review row would
  // make the next file's `delete from google_connections` fail on a constraint that has nothing to do
  // with it. Leaving that trap for another test file is exactly what the brief's `finally` rule is about.
  await sql`delete from google_reviews`
  await sql`delete from google_connections`
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from google_reviews`
  await sql`delete from google_connections`
})

/** A connection plus the `gbp_reviews` capability that names the listing it manages. */
async function seedConnection(sub: string, placeId: string): Promise<string> {
  const [connection] = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp)
    values (${sub}, ${'owner@berelax.ae'},
            ${sql.array(['https://www.googleapis.com/auth/business.manage'])},
            ${CT}, ${CT}, ${CT}, 'v1', 'fp-stand-in')
    returning id
  `
  const id = connection?.id ?? ''
  await sql`
    insert into google_capabilities (connection_id, capability, resource_ref, health, is_primary)
    values (${id}, 'gbp_reviews', ${sql.json({ placeId })}, 'permission_missing', true)
  `
  return id
}

type ReviewColumns = Record<string, string | number | null | Date | undefined>

async function insertReview(
  connectionId: string,
  placeId: string,
  overrides: ReviewColumns = {},
): Promise<string> {
  const row: ReviewColumns = {
    connection_id: connectionId,
    place_id: placeId,
    source: 'paste',
    delivery_mode: 'manual',
    rating: 5,
    reviewer_display_name: ANONYMOUS,
    reviewed_at: '2026-09-15T23:58:00.000Z',
    ...overrides,
  }
  const rows = await sql<{ id: string }[]>`insert into google_reviews ${sql(row)} returning id`
  return rows[0]?.id ?? ''
}

describe('acceptance — google_review_id is nullable, and unique only where present', () => {
  it('stores two id-less reviews, one with an id, and refuses a duplicate id', async () => {
    const connection = await seedConnection('sub-nullable', PLACE_A)

    // 1. Two pasted reviews, neither of which has a Google id. This is the launch-mode normal: the
    //    notification email does not carry the review id, so NOT NULL here would delete the paste form.
    const first = await insertReview(connection, PLACE_A)
    const second = await insertReview(connection, PLACE_A)
    expect(first).not.toBe(second)
    const [idless] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_reviews where google_review_id is null
    `
    expect(idless?.n).toBe('2')

    // 2. A real id inserts.
    await insertReview(connection, PLACE_A, { google_review_id: 'rev-5-en' })

    // 3. The same id a second time does not — which is what makes the at-least-once replay safe.
    await expect(
      insertReview(connection, PLACE_A, { google_review_id: 'rev-5-en' }),
    ).rejects.toThrow(/google_reviews_google_review_id_key/)
  })

  it('enforces that uniqueness through a partial index, not a plain one', async () => {
    // The control on the test above: a plain unique index would also have rejected the duplicate, and
    // would have rejected the second NULL row too under `nulls not distinct`. The predicate is the
    // difference, so the predicate is what is asserted.
    const [index] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where tablename = 'google_reviews' and indexname = 'google_reviews_google_review_id_key'
    `
    expect(index?.indexdef).toMatch(/UNIQUE/)
    expect(index?.indexdef).toMatch(/WHERE \(google_review_id IS NOT NULL\)/)
  })
})

describe('acceptance — delivery_mode is a column, and there is no posted_at anywhere', () => {
  it('is NOT NULL and constrained to exactly api|manual', async () => {
    const [column] = await sql<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default from information_schema.columns
      where table_name = 'google_reviews' and column_name = 'delivery_mode'
    `
    expect(column?.is_nullable).toBe('NO')
    // No default either: the intake path knows which mode it is, and a default is how a caller that
    // never decided gets read as if it had.
    expect(column?.column_default).toBeNull()

    const [check] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'google_reviews'::regclass and conname = 'google_reviews_delivery_mode_check'
    `
    const def = check?.def ?? ''
    expect(def).toContain('api')
    expect(def).toContain('manual')
    // Exactly two. A third value slipping in silently is how 'posted' becomes a delivery mode.
    expect(def.match(/'[a-z_]+'::text/g)).toHaveLength(2)
  })

  it('rejects a third delivery mode and a missing one', async () => {
    const connection = await seedConnection('sub-mode', PLACE_A)
    // Either constraint may report it, and which one is not ours to choose: PostgreSQL does not
    // promise an order over a row's checks, and 'posted' fails both the enum and the `else false` arm
    // of the delivery-fields check. That redundancy is deliberate — a third mode added later has no
    // delivery rules until somebody writes them, and `else false` is what says so.
    await expect(insertReview(connection, PLACE_A, { delivery_mode: 'posted' })).rejects.toThrow(
      /google_reviews_(delivery_mode_check|delivery_fields_match_mode)/,
    )
    await expect(insertReview(connection, PLACE_A, { delivery_mode: null })).rejects.toThrow(
      /delivery_mode/,
    )
  })

  it('has no column named posted_at on any review table', async () => {
    // Asked of information_schema rather than of the migration file, because the file is not what
    // queries run against. `delivery_mode` plus submitted_at/confirmed_at/posted_manually_at is the
    // shape; one overloaded `posted_at` reads identically whether the system sent the reply or a human
    // said they had, which is the only question anybody asks of it afterwards (docs/10 §6).
    const reviewTables = await sql<{ table_name: string }[]>`
      select distinct table_name from information_schema.columns
      where table_schema = 'public' and table_name like '%review%'
    `
    // Vacuity guard: if the name filter matched nothing, the emptiness below would prove nothing.
    expect(reviewTables.map((t) => t.table_name)).toContain('google_reviews')

    const offending = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name like '%review%' and column_name = 'posted_at'
    `
    expect(offending).toEqual([])

    // The control that makes the query above meaningful: the same query, same filters, for a column
    // that IS there. Without it, a typo in the table filter would report success forever.
    const present = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name like '%review%'
        and column_name in ('delivery_mode', 'posted_manually_at', 'submitted_at', 'confirmed_at')
    `
    expect(present.map((c) => c.column_name).sort()).toEqual([
      'confirmed_at',
      'delivery_mode',
      'posted_manually_at',
      'submitted_at',
    ])
  })
})

describe('acceptance — the delivery timestamps coexist and exclude each other per row', () => {
  it('accepts a manual delivery with submitted_at NULL', async () => {
    const connection = await seedConnection('sub-manual', PLACE_A)
    const id = await insertReview(connection, PLACE_A, {
      delivery_mode: 'manual',
      posted_manually_at: '2026-09-16T06:00:00.000Z',
    })
    const [row] = await sql<{ submitted_at: Date | null; posted_manually_at: Date | null }[]>`
      select submitted_at, posted_manually_at from google_reviews where id = ${id}
    `
    expect(row?.submitted_at).toBeNull()
    expect(row?.posted_manually_at).not.toBeNull()
  })

  it('accepts an api delivery with posted_manually_at NULL, submitted then confirmed', async () => {
    const connection = await seedConnection('sub-api', PLACE_A)
    const id = await insertReview(connection, PLACE_A, {
      source: 'api',
      delivery_mode: 'api',
      google_review_id: 'rev-3-mixed',
      google_update_time: '2026-09-13T15:20:00.000Z',
      submitted_at: '2026-09-13T16:00:00.000Z',
      confirmed_at: '2026-09-13T16:00:04.000Z',
    })
    const [row] = await sql<
      { submitted_at: Date | null; confirmed_at: Date | null; posted_manually_at: Date | null }[]
    >`
      select submitted_at, confirmed_at, posted_manually_at from google_reviews where id = ${id}
    `
    expect(row?.posted_manually_at).toBeNull()
    // Two timestamps, not one: the API acknowledges separately from the submission, and a single
    // column could not hold both halves.
    expect(row?.submitted_at).not.toBeNull()
    expect(row?.confirmed_at).not.toBeNull()
  })

  it('rejects a row that populates both modes, in either direction', async () => {
    const connection = await seedConnection('sub-both', PLACE_A)
    await expect(
      insertReview(connection, PLACE_A, {
        delivery_mode: 'api',
        submitted_at: '2026-09-16T06:00:00.000Z',
        posted_manually_at: '2026-09-16T06:05:00.000Z',
      }),
    ).rejects.toThrow(/google_reviews_delivery_fields_match_mode/)
    await expect(
      insertReview(connection, PLACE_A, {
        delivery_mode: 'manual',
        submitted_at: '2026-09-16T06:00:00.000Z',
        posted_manually_at: '2026-09-16T06:05:00.000Z',
      }),
    ).rejects.toThrow(/google_reviews_delivery_fields_match_mode/)
  })

  it('rejects an acknowledgement of a reply that was never submitted', async () => {
    const connection = await seedConnection('sub-confirm', PLACE_A)
    await expect(
      insertReview(connection, PLACE_A, {
        delivery_mode: 'api',
        confirmed_at: '2026-09-16T06:00:00.000Z',
      }),
    ).rejects.toThrow(/google_reviews_confirmed_needs_submitted/)
  })
})

describe('acceptance — a star-only review is an ordinary row', () => {
  it('stores rating 5 with no comment text', async () => {
    // docs/10 §7: star-only reviews are common, and they are what an autoresponder handles worst. If
    // the column were NOT NULL the generator would be handed '' and would answer as if there were text.
    const connection = await seedConnection('sub-star', PLACE_A)
    const id = await insertReview(connection, PLACE_A, { rating: 5, comment_text: null })
    const [row] = await sql<{ rating: number; comment_text: string | null }[]>`
      select rating, comment_text from google_reviews where id = ${id}
    `
    expect(row?.rating).toBe(5)
    expect(row?.comment_text).toBeNull()
  })

  it('refuses the empty string, so star-only has exactly one representation', async () => {
    // The control on the test above. Two spellings of "no comment" means every reader has to know
    // both, and the first one that forgets sends a reply to a review that says nothing.
    const connection = await seedConnection('sub-empty', PLACE_A)
    await expect(insertReview(connection, PLACE_A, { comment_text: '' })).rejects.toThrow(
      /google_reviews_comment_text_check/,
    )
    await expect(insertReview(connection, PLACE_A, { comment_text: '   ' })).rejects.toThrow(
      /google_reviews_comment_text_check/,
    )
  })

  it('rejects a rating outside 1..5', async () => {
    const connection = await seedConnection('sub-rating', PLACE_A)
    await expect(insertReview(connection, PLACE_A, { rating: 6 })).rejects.toThrow(/rating/)
    await expect(insertReview(connection, PLACE_A, { rating: 0 })).rejects.toThrow(/rating/)
  })
})

describe('acceptance — source, and the listing a review belongs to', () => {
  it('constrains source to exactly api|email_parse|paste|manual', async () => {
    const [check] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'google_reviews'::regclass and conname = 'google_reviews_source_check'
    `
    const def = check?.def ?? ''
    for (const source of ['api', 'email_parse', 'paste', 'manual']) expect(def).toContain(source)
    expect(def.match(/'[a-z_]+'::text/g)).toHaveLength(4)

    const connection = await seedConnection('sub-source', PLACE_A)
    // 'scrape' is the one docs/10 §6 says not to build. It cannot even be recorded.
    await expect(insertReview(connection, PLACE_A, { source: 'scrape' })).rejects.toThrow(/source/)
  })

  it('refuses a place_id that belongs to another connection', async () => {
    // The cross-contamination case, which is ordinary rather than exotic: the account owning the
    // listing is frequently not the account verified on the site (docs/10 §2), so two connections
    // exist. A row filed under the wrong one has the owner replying in public as the wrong business.
    const a = await seedConnection('sub-listing-a', PLACE_A)
    const b = await seedConnection('sub-listing-b', PLACE_B)

    await insertReview(a, PLACE_A)
    await insertReview(b, PLACE_B)

    await expect(insertReview(a, PLACE_B)).rejects.toThrow(/not a gbp_reviews resource/)
    // And it cannot be moved there afterwards either — a check only on insert would be a check on
    // the path nobody uses.
    const id = await insertReview(b, PLACE_B)
    await expect(
      sql`update google_reviews set place_id = ${PLACE_A} where id = ${id}`,
    ).rejects.toThrow(/not a gbp_reviews resource/)
  })

  it('keeps the queue of one connection out of the other', async () => {
    const a = await seedConnection('sub-queue-a', PLACE_A)
    const b = await seedConnection('sub-queue-b', PLACE_B)
    await insertReview(a, PLACE_A)
    await insertReview(a, PLACE_A)
    await insertReview(b, PLACE_B)

    const scoped = await sql<{ n: string }[]>`
      select count(*)::text as n from google_reviews
      where connection_id = ${a} and place_id = ${PLACE_A}
    `
    expect(scoped[0]?.n).toBe('2')
    // The control: unscoped, all three are there, so the count above is the scoping working rather
    // than the fixture being thin.
    const all = await sql<{ n: string }[]>`select count(*)::text as n from google_reviews`
    expect(all[0]?.n).toBe('3')
  })

  it('refuses to delete a connection that still has reviews', async () => {
    // ON DELETE RESTRICT. Disconnecting Google is a status change; a cascade here would delete a
    // queue of approved drafts as a side effect of a settings click.
    const connection = await seedConnection('sub-restrict', PLACE_A)
    await insertReview(connection, PLACE_A)
    await expect(sql`delete from google_connections where id = ${connection}`).rejects.toThrow(
      /google_reviews/,
    )

    // The control: with the reviews gone the same delete succeeds, so the rejection above is the
    // foreign key and not something else refusing the statement.
    await sql`delete from google_reviews where connection_id = ${connection}`
    await sql`delete from google_connections where id = ${connection}`
    const [left] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_connections where id = ${connection}
    `
    expect(left?.n).toBe('0')
  })
})

describe('acceptance — the routing verdict columns, and the floor the database owns (0037)', () => {
  /** The four columns 0037 adds, all nullable because "not routed yet" is a real state of the queue. */
  const ROUTING_COLUMNS = [
    'routing_verdict',
    'routing_rule_id',
    'routing_lexicon_version',
    'routed_at',
  ] as const

  it('adds four nullable columns with no default', async () => {
    const rows = await sql<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >`
      select column_name, is_nullable, column_default from information_schema.columns
      where table_name = 'google_reviews' and column_name = any(${sql.array([...ROUTING_COLUMNS])})
      order by column_name
    `
    expect(rows.map((row) => row.column_name).sort()).toEqual([...ROUTING_COLUMNS].sort())
    for (const row of rows) {
      // Nullable: an unrouted review has no verdict, and a default would let a row read as decided.
      expect(row.is_nullable, row.column_name).toBe('YES')
      expect(row.column_default, row.column_name).toBeNull()
    }
  })

  it('refuses a verdict recorded without its rule or its lexicon version', async () => {
    const connection = await seedConnection('sub-routing-partial', PLACE_A)
    const id = await insertReview(connection, PLACE_A, { rating: 1 })
    // Half a decision. A verdict with no rule is one nobody can audit, and a rule with no verdict is a
    // reason for nothing.
    await expect(
      sql`update google_reviews set routing_verdict = 'escalate' where id = ${id}`,
    ).rejects.toThrow(/google_reviews_routing_recorded_together/)
    await expect(
      sql`update google_reviews set routing_rule_id = 'rating_escalates' where id = ${id}`,
    ).rejects.toThrow(/google_reviews_routing_recorded_together/)
    // The control: all four together is accepted, so the constraint is not refusing everything.
    await sql`
      update google_reviews set routing_verdict = 'escalate', routing_rule_id = 'rating_escalates',
        routing_lexicon_version = '2026-09-19', routed_at = now()
      where id = ${id}
    `
    const [row] = await sql<{ routing_verdict: string }[]>`
      select routing_verdict from google_reviews where id = ${id}
    `
    expect(row?.routing_verdict).toBe('escalate')
  })

  it('constrains the verdict to exactly auto_send|escalate', async () => {
    const connection = await seedConnection('sub-routing-vocab', PLACE_A)
    const id = await insertReview(connection, PLACE_A, { rating: 1 })
    await expect(
      sql`
        update google_reviews set routing_verdict = 'send_it', routing_rule_id = 'x',
          routing_lexicon_version = 'v', routed_at = now()
        where id = ${id}
      `,
    ).rejects.toThrow(/google_reviews_routing_verdict_known/)
  })

  it('refuses a blank rule id or lexicon version, so absent has one spelling', async () => {
    const connection = await seedConnection('sub-routing-blank', PLACE_A)
    const id = await insertReview(connection, PLACE_A, { rating: 1 })
    await expect(
      sql`
        update google_reviews set routing_verdict = 'escalate', routing_rule_id = '   ',
          routing_lexicon_version = 'v', routed_at = now()
        where id = ${id}
      `,
    ).rejects.toThrow(/google_reviews_routing_rule_id_not_blank/)
    await expect(
      sql`
        update google_reviews set routing_verdict = 'escalate', routing_rule_id = 'x',
          routing_lexicon_version = '', routed_at = now()
        where id = ${id}
      `,
    ).rejects.toThrow(/google_reviews_routing_lexicon_version_not_blank/)
  })

  it('accepts any rule id, deliberately, because the closed set lives in packages/core', async () => {
    // Asserted as a deliberate ABSENCE. The rule list changes when the routing table changes, a copy in
    // SQL would silently disagree between deploys, and `packages/db` may not import `packages/core` to
    // keep them in step. So an id this build does not know is stored and is read as `escalate` by
    // `reviewVerdictForRule` — proved in packages/google/src/review-routing.itest.ts. This assertion is
    // here so that ADDING such a constraint fails a test rather than looking like an improvement.
    const connection = await seedConnection('sub-routing-open', PLACE_A)
    const id = await insertReview(connection, PLACE_A, { rating: 1 })
    await sql`
      update google_reviews set routing_verdict = 'escalate',
        routing_rule_id = 'a_rule_a_later_build_added', routing_lexicon_version = 'v2', routed_at = now()
      where id = ${id}
    `
    const [row] = await sql<{ routing_rule_id: string }[]>`
      select routing_rule_id from google_reviews where id = ${id}
    `
    expect(row?.routing_rule_id).toBe('a_rule_a_later_build_added')
  })

  it('refuses auto_send on a low rating, on a texted review, and outside api delivery', async () => {
    const connection = await seedConnection('sub-routing-floor', PLACE_A)
    const route = (id: string) => sql`
      update google_reviews set routing_verdict = 'auto_send', routing_rule_id = 'forced',
        routing_lexicon_version = 'v', routed_at = now()
      where id = ${id}
    `
    // Each probe leaves only ONE floor able to refuse it, so the constraint named is the one under test
    // rather than whichever Postgres happened to evaluate first (ADR 0003).
    const lowRated = await insertReview(connection, PLACE_A, { rating: 1, delivery_mode: 'api' })
    await expect(route(lowRated)).rejects.toThrow(/google_reviews_autosend_needs_high_rating/)

    const texted = await insertReview(connection, PLACE_A, {
      rating: 5,
      delivery_mode: 'api',
      comment_text: 'Lovely, thank you.',
    })
    await expect(route(texted)).rejects.toThrow(/google_reviews_autosend_needs_no_comment/)

    const manual = await insertReview(connection, PLACE_A, { rating: 5, delivery_mode: 'manual' })
    await expect(route(manual)).rejects.toThrow(/google_reviews_autosend_needs_api_delivery/)

    // The control: the one shape docs/07 §4 permits is accepted. Without it, a CHECK that refused every
    // auto_send would satisfy all three probes above.
    const quiet = await insertReview(connection, PLACE_A, { rating: 4, delivery_mode: 'api' })
    await route(quiet)
    const [row] = await sql<{ routing_verdict: string }[]>`
      select routing_verdict from google_reviews where id = ${quiet}
    `
    expect(row?.routing_verdict).toBe('auto_send')
  })

  it('indexes the escalation queue and the unrouted backlog partially', async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where tablename = 'google_reviews'
        and indexname in ('google_reviews_escalated_idx', 'google_reviews_unrouted_idx')
      order by indexname
    `
    expect(rows.map((row) => row.indexname)).toEqual([
      'google_reviews_escalated_idx',
      'google_reviews_unrouted_idx',
    ])
    // The predicate is the point: both reads are a small and differently-growing fraction of the table,
    // and an unpartitioned index would grow with every review ever left.
    expect(rows[0]?.indexdef).toMatch(/WHERE \(routing_verdict = 'escalate'/)
    expect(rows[1]?.indexdef).toMatch(/WHERE \(routing_verdict IS NULL\)/)
  })
})

describe('acceptance — the reply draft columns, and the ordering the database owns (0048)', () => {
  /** The eight columns 0048 adds, all nullable because "not drafted yet" is a real state of the queue. */
  const DRAFT_COLUMNS = [
    'reply_draft_skeleton_id',
    'reply_draft_aspects',
    'reply_draft_language',
    'reply_draft_prompt_version',
    'reply_draft_prompt_fingerprint',
    'reply_draft_generated_at',
    'draft_quarantine_reason',
    'draft_quarantined_at',
  ] as const

  /** A routed review, which is the only state a draft may be written against. */
  async function routedReview(sub: string, overrides: ReviewColumns = {}): Promise<string> {
    const connection = await seedConnection(sub, PLACE_A)
    const id = await insertReview(connection, PLACE_A, overrides)
    await sql`
      update google_reviews set routing_verdict = 'escalate', routing_rule_id = 'free_text_present',
        routing_lexicon_version = '2026-09-19', routed_at = now()
      where id = ${id}
    `
    return id
  }

  /** Every provenance column at once, which is the only shape the group constraint accepts. */
  const provenance = (draft: string) => ({
    reply_draft: draft,
    reply_draft_skeleton_id: 'positive_thanks',
    reply_draft_language: 'en',
    reply_draft_prompt_version: 'g-rev-04-1',
    reply_draft_prompt_fingerprint: 'deadbeef',
  })

  it('adds eight nullable columns with no default', async () => {
    const rows = await sql<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >`
      select column_name, is_nullable, column_default from information_schema.columns
      where table_name = 'google_reviews' and column_name = any(${sql.array([...DRAFT_COLUMNS])})
      order by column_name
    `
    expect(rows.map((row) => row.column_name).sort()).toEqual([...DRAFT_COLUMNS].sort())
    for (const row of rows) {
      expect(row.is_nullable, row.column_name).toBe('YES')
      expect(row.column_default, row.column_name).toBeNull()
    }
  })

  it('refuses half a provenance, so a draft nobody can reproduce cannot be stored', async () => {
    const id = await routedReview('sub-draft-partial', {
      comment_text: 'Great massage, thank you.',
    })
    // Each probe leaves exactly ONE constraint able to refuse it, which is the difference between
    // asserting a name and asserting that something went wrong. The draft is written alongside the half
    // provenance so that `..._needs_a_draft` is satisfied, and the row is routed so that
    // `..._needs_a_verdict` is too — leaving `..._provenance_together` as the only possible objection.
    await expect(
      sql`
        update google_reviews
        set reply_draft = 'Thank you for the rating.', reply_draft_skeleton_id = 'positive_thanks'
        where id = ${id}
      `,
    ).rejects.toThrow(/google_reviews_draft_provenance_together/)
    await expect(
      sql`
        update google_reviews
        set reply_draft = 'Thank you for the rating.', reply_draft_prompt_fingerprint = 'deadbeef'
        where id = ${id}
      `,
    ).rejects.toThrow(/google_reviews_draft_provenance_together/)
    // The control: all six together is accepted, so the constraint is not refusing everything.
    await sql`
      update google_reviews set ${sql({ ...provenance('Thank you for the rating.'), reply_draft_aspects: sql.array(['treatment']), reply_draft_generated_at: new Date() })}
      where id = ${id}
    `
    const [row] = await sql<{ reply_draft_skeleton_id: string }[]>`
      select reply_draft_skeleton_id from google_reviews where id = ${id}
    `
    expect(row?.reply_draft_skeleton_id).toBe('positive_thanks')
  })

  it('refuses provenance with no draft to describe', async () => {
    const id = await routedReview('sub-draft-orphan', { comment_text: 'Good massage, very clean.' })
    await expect(
      sql`
        update google_reviews set ${sql({ reply_draft: null, reply_draft_skeleton_id: 'positive_thanks', reply_draft_language: 'en', reply_draft_prompt_version: 'g-rev-04-1', reply_draft_prompt_fingerprint: 'deadbeef', reply_draft_aspects: sql.array([]), reply_draft_generated_at: new Date() })}
        where id = ${id}
      `,
    ).rejects.toThrow(/google_reviews_draft_provenance_needs_a_draft/)
  })

  it('refuses a machine draft on a review nobody routed, which is the ordering as a database fact', async () => {
    // THE constraint. Generation consumes a verdict (docs/07 §4 decides whether a human must read the
    // review at all), so a draft on an unrouted row is a reply outside the table entirely.
    const connection = await seedConnection('sub-draft-unrouted', PLACE_A)
    const id = await insertReview(connection, PLACE_A, { comment_text: 'Lovely, thank you all.' })
    await expect(
      sql`
        update google_reviews set ${sql({ ...provenance('Thank you for the rating.'), reply_draft_aspects: sql.array([]), reply_draft_generated_at: new Date() })}
        where id = ${id}
      `,
    ).rejects.toThrow(/google_reviews_draft_needs_a_verdict/)

    // The control: the identical write on a ROUTED row is accepted. Without it this would pass on any
    // constraint that refused the write for some other reason.
    await sql`
      update google_reviews set routing_verdict = 'escalate', routing_rule_id = 'free_text_present',
        routing_lexicon_version = '2026-09-19', routed_at = now()
      where id = ${id}
    `
    await sql`
      update google_reviews set ${sql({ ...provenance('Thank you for the rating.'), reply_draft_aspects: sql.array([]), reply_draft_generated_at: new Date() })}
      where id = ${id}
    `
    const [row] = await sql<{ reply_draft: string }[]>`
      select reply_draft from google_reviews where id = ${id}
    `
    expect(row?.reply_draft).toBe('Thank you for the rating.')
  })

  it('constrains the reply language to exactly en|ar', async () => {
    const [check] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'google_reviews'::regclass
        and conname = 'google_reviews_draft_language_known'
    `
    const def = check?.def ?? ''
    expect(def).toContain('en')
    expect(def).toContain('ar')
    // Exactly two. A third is a language nothing can identify, so a reply in it cannot be checked.
    expect(def.match(/'[a-z]+'::text/g)).toHaveLength(2)
  })

  it('refuses a blank skeleton id, prompt version or fingerprint, so absent has one spelling', async () => {
    const id = await routedReview('sub-draft-blank', { comment_text: 'Very good, thank you.' })
    const withBlank = (overrides: ReviewColumns) =>
      sql`
        update google_reviews set ${sql({ ...provenance('Thank you for the rating.'), reply_draft_aspects: sql.array([]), reply_draft_generated_at: new Date(), ...overrides })}
        where id = ${id}
      `
    await expect(withBlank({ reply_draft_skeleton_id: '   ' })).rejects.toThrow(
      /google_reviews_draft_skeleton_not_blank/,
    )
    await expect(withBlank({ reply_draft_prompt_version: '' })).rejects.toThrow(
      /google_reviews_draft_prompt_version_not_blank/,
    )
    await expect(withBlank({ reply_draft_prompt_fingerprint: ' ' })).rejects.toThrow(
      /google_reviews_draft_fingerprint_not_blank/,
    )
  })

  it('refuses half a quarantine, and refuses a quarantine that carries a machine draft', async () => {
    const id = await routedReview('sub-draft-quarantine', {
      comment_text: 'Fine, thanks for that.',
    })
    await expect(
      sql`update google_reviews set draft_quarantine_reason = 'response_promises_money' where id = ${id}`,
    ).rejects.toThrow(/google_reviews_draft_quarantine_together/)
    await expect(
      sql`update google_reviews set draft_quarantined_at = now() where id = ${id}`,
    ).rejects.toThrow(/google_reviews_draft_quarantine_together/)
    await expect(
      sql`update google_reviews set draft_quarantine_reason = '  ', draft_quarantined_at = now() where id = ${id}`,
    ).rejects.toThrow(/google_reviews_draft_quarantine_reason_not_blank/)

    // The control: the pair together is accepted.
    await sql`
      update google_reviews set draft_quarantine_reason = 'response_promises_money',
        draft_quarantined_at = now()
      where id = ${id}
    `
    // And a machine draft cannot now be added beside it. A bland house sentence offered next to "this
    // review attempted a prompt injection" is a sentence that gets approved.
    await expect(
      sql`
        update google_reviews set ${sql({ ...provenance('Thank you for the rating.'), reply_draft_aspects: sql.array([]), reply_draft_generated_at: new Date() })}
        where id = ${id}
      `,
    ).rejects.toThrow(/google_reviews_draft_quarantine_has_no_machine_draft/)
  })

  it('indexes the undrafted backlog partially, because it is a small and differently-growing slice', async () => {
    const [index] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where tablename = 'google_reviews' and indexname = 'google_reviews_undrafted_idx'
    `
    const def = index?.indexdef ?? ''
    expect(def).toContain('WHERE')
    expect(def).toContain('routing_verdict IS NOT NULL')
    expect(def).toContain('reply_draft IS NULL')
    expect(def).toContain('draft_quarantine_reason IS NULL')
  })
})
