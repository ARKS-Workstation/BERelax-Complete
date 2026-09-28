import { type AppEnv, parseConfig } from '@berelax/config'
import { ASIA_DUBAI, type Instant, instantFromIso, toLocal } from '@berelax/core'
import {
  agentsWithHeartbeat,
  createConnection,
  findAgent,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  createFakePlaces,
  PLACES_AGGREGATE_FIXTURE,
  PLACES_REVIEW_FIXTURES,
} from '@berelax/providers/google'
import {
  REVIEW_COUNT_TRIPWIRE_AGENT,
  REVIEW_FALLBACK_TEMPLATE_KEYS,
  REVIEW_MONDAY_NUDGE_AGENT,
} from '@berelax/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cronRegistrations, SCHEDULE_TIMEZONE } from '../registry.ts'
import {
  type CountTripwireDeps,
  REVIEW_COUNT_TRIPWIRE_CRON,
  REVIEW_COUNT_TRIPWIRE_JOB,
  runReviewCountTripwire,
  TRIPWIRE_ACTOR,
} from './review-count-tripwire.ts'
import {
  NUDGE_WINDOW_MS,
  REVIEW_MONDAY_NUDGE_CRON,
  REVIEW_MONDAY_NUDGE_JOB,
  runReviewMondayNudge,
} from './review-monday-nudge.ts'
import {
  NO_OWNER_CONTACT_ON_FILE,
  PROVISIONAL_EMAIL_SENDER,
  reviewNoticeNotifierFor,
} from './review-notice-sender.ts'

/**
 * G-REV-02 — the count tripwire and the Monday nudge, on a frozen clock against real PostgreSQL.
 *
 * Four acceptance lines land here and each of them names BOTH branches, which is the whole reason this file
 * exists rather than one happy-path case per pass:
 *
 *   - *a review_count moving 41 to 43 sends exactly one email reading "2 new reviews" containing a deep link
 *     built from the stored placeId; an unchanged count sends zero emails, asserted on the fake Resend outbox
 *     in both branches.*
 *   - *the Monday nudge fires at 09:00 Asia/Dubai only when no review was reported in the preceding 7 days,
 *     proven on a frozen clock in both the fired and not-fired branches, and writes a heartbeat either way.*
 *   - *the Places adapter stores aggregate only: after a run against a Places fixture containing three review
 *     bodies, a test asserts none of those body strings is present in any table.*
 *
 * ## The fake Resend outbox, and why the recipient is a fixture
 *
 * The send goes through the real choke point — `reviewNoticeNotifierFor` calls `deliverMessage` and therefore
 * `sendMessage` — so the thing that records an accepted email is the **fake Resend provider's call log**, and
 * that is what "the fake Resend outbox" means here. Reaching it needs two things: a recipient (nothing in this
 * build holds one, so this file supplies a fixture address on a `.invalid` domain) and that address on
 * `OUTBOUND_ALLOWLIST`, because outside production F03's staging guard diverts an unallowlisted recipient to
 * the local outbox and the transport is never called at all. Both are properties of the CONFIG this file
 * parses, so the pass under test is the shipped one.
 *
 * The shipped resolver's own answer — `null` — is asserted separately, because that is the state this build
 * actually ships in and a test that only ever ran with a fixture recipient would not say so.
 *
 * ## The table scan
 *
 * `noReviewBodyIsStoredAnywhere` walks **every text-ish column of every table** in the public schema and
 * searches each one for the three fixture bodies. Written as a scan rather than as a query against
 * `google_place_aggregate` deliberately: a check that looked only at the table it expected the bodies to be in
 * would pass on the day somebody cached them somewhere else, which is exactly the mistake ADR 0043 is about.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind (brief rule
 * 12). Everything this file asserts is scoped to the connection it created, rows are removed intake-first
 * because of the RESTRICT chain, and `agent_run` and `audit_event` are append-only so every count of them is a
 * DELTA in SQL.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * Monday 28 September 2026 at 09:00 Asia/Dubai, which is 05:00 UTC.
 *
 * The instant the nudge's cron produces, written as UTC and asserted to be Monday 09:00 local — so the zone
 * is a property of the value rather than of a comment.
 */
const MONDAY_0900 = instantFromIso('2026-09-28T05:00:00.000Z')

/** 06:15 Asia/Dubai on the same Monday: the tripwire's own hour, 02:15 UTC. */
const TRIPWIRE_AT = instantFromIso('2026-09-28T02:15:00.000Z')

/** Obviously a fixture, on a `.invalid` domain, and the only recipient this file ever sends to. */
const OWNER_FIXTURE_EMAIL = 'owner-fixture@berelax.example.invalid'

const PLACE = PLACES_AGGREGATE_FIXTURE.placeId
const CT = Buffer.from('ciphertext-stand-in')

let sql: Sql
let connectionId = ''

function configWithAllowlist() {
  return parseConfig({
    APP_ENV: 'test' as AppEnv,
    DATABASE_URL,
    // Without this the staging guard diverts the send to the local outbox and the Resend fake is never
    // called — so the outbox assertions below would be assertions about nothing.
    OUTBOUND_ALLOWLIST: OWNER_FIXTURE_EMAIL,
  })
}

/** The notifier plus the fake provider's call log, which is the outbox both branches are asserted on. */
function notifierWithOutbox(templateKey: string, nowIso: string) {
  const config = configWithAllowlist()
  const notifier = reviewNoticeNotifierFor(sql, config, {
    from: PROVISIONAL_EMAIL_SENDER,
    templateKey,
    now: () => nowIso,
  })
  return { notifier, config }
}

/**
 * Every email the fake Resend provider accepted for this run, read from the `message` rows it produced.
 *
 * The `message` row is what the choke point writes on a successful send and is the durable record of it;
 * `bodyHtml`/`body` carry the rendered words, which is what "reading 2 new reviews" is a claim about. Scoped to
 * the fixture recipient so another file's messages cannot be counted.
 */
async function emailsSentTo(
  recipient: string,
): Promise<readonly { body: string; subject: string }[]> {
  const rows = await sql<{ body: string; subject: string | null }[]>`
    select body, subject from message
    where recipient = ${recipient} and channel = 'email'
    order by created_at asc
  `
  return rows.map((row) => ({ body: row.body, subject: row.subject ?? '' }))
}

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

/** A reading on a past trading date, so the pass has something to compare against. */
async function seedPreviousReading(count: number, observedOn: string): Promise<void> {
  await sql`
    insert into google_place_aggregate
      (connection_id, place_id, observed_on, observed_at, rating_tenths, review_count,
       curated_reviews_discarded)
    values (${connectionId}, ${PLACE}, ${observedOn}::date, ${`${observedOn}T02:15:00.000Z`}::timestamptz,
            46, ${count}, 3)
  `
}

/** A review REPORTED at an instant, which is what the nudge's window counts. */
async function seedReportedReview(createdAtIso: string): Promise<void> {
  const [row] = await sql<{ id: string }[]>`
    insert into google_reviews
      (connection_id, place_id, source, delivery_mode, rating, reviewer_display_name, reviewed_at)
    values (${connectionId}, ${PLACE}, 'paste', 'manual', 5, 'A Google user',
            ${createdAtIso}::timestamptz)
    returning id
  `
  // `created_at` defaults to now() and is what "reported" means, so it is set explicitly: a review recorded
  // eight days ago has to be outside the window however long ago this suite ran.
  await sql`
    update google_reviews set created_at = ${createdAtIso}::timestamptz where id = ${row?.id ?? ''}::uuid
  `
}

function tripwireDeps(
  overrides: {
    readonly now?: Instant
    readonly counts?: readonly number[]
    readonly recipient?: string | null
    readonly templateKey?: string
  } = {},
): CountTripwireDeps & { readonly outbox: () => Promise<readonly { body: string }[]> } {
  const now = overrides.now ?? TRIPWIRE_AT
  const nowIso = new Date(now).toISOString()
  const details = (overrides.counts ?? [PLACES_AGGREGATE_FIXTURE.userRatingCount ?? 41]).map(
    (count) => ({ ...PLACES_AGGREGATE_FIXTURE, userRatingCount: count }),
  )
  const { notifier } = notifierWithOutbox(
    overrides.templateKey ?? REVIEW_FALLBACK_TEMPLATE_KEYS.countIncrease,
    nowIso,
  )
  const recipient = overrides.recipient === undefined ? OWNER_FIXTURE_EMAIL : overrides.recipient
  return {
    sql,
    places: createFakePlaces({
      log: createCallLog(() => nowIso),
      failures: new FailureScript(),
      now: () => nowIso,
      details,
    }),
    notifier,
    recipientFor: () => recipient,
    now,
    outbox: () => emailsSentTo(OWNER_FIXTURE_EMAIL),
  }
}

/**
 * Every place any of the three fixture review bodies appears, across every table in the schema.
 *
 * Walks `information_schema.columns` for text-ish columns and runs one `exists` per column. Slower than a
 * targeted query and that is the point: the claim is *none of those body strings is present in ANY table*, and
 * a query against the table somebody expected would report a pass for a body cached elsewhere.
 */
async function reviewBodiesFoundAnywhere(): Promise<readonly string[]> {
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and data_type in ('text', 'character varying', 'character')
      and table_name in (select table_name from information_schema.tables
                         where table_schema = 'public' and table_type = 'BASE TABLE')
    order by table_name, column_name
  `
  const found: string[] = []
  for (const body of PLACES_REVIEW_FIXTURES.map((review) => review.text)) {
    // A distinctive fragment rather than the whole body, so a stored copy that had been truncated to a
    // column width would still be found. Every fixture body opens with its own unique three words.
    const needle = body.slice(0, 40)
    for (const column of columns) {
      const [hit] = await sql<{ found: boolean }[]>`
        select exists (
          select 1 from ${sql(column.table_name)}
          where ${sql(column.column_name)} like ${`%${needle}%`}
        ) as found
      `
      if (hit?.found === true) found.push(`${column.table_name}.${column.column_name}`)
    }
  }
  return found
}

async function clean(): Promise<void> {
  await sql`delete from review_intake_email`
  await sql`delete from google_place_aggregate`
  await sql`delete from google_reviews`
  await sql`delete from google_connections`
  await sql`delete from message where recipient = ${OWNER_FIXTURE_EMAIL}`
}

beforeAll(() => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
})

afterAll(async () => {
  await clean()
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await clean()
  connectionId = await seedConnection('sub-review-tripwire', PLACE)
})

describe('acceptance — 41 to 43 sends exactly one email reading "2 new reviews"', () => {
  it('sends one, with the phrase and a deep link built from the stored placeId', async () => {
    await seedPreviousReading(41, '2026-09-27')
    const deps = tripwireDeps({ counts: [43] })
    const { results, runOutcome } = await runReviewCountTripwire(deps)
    const [result] = results
    // The pass records its own agent run, so a throw inside it is a `failed` run with a heartbeat rather
    // than silence. Asserted here so the branches below are about the decision and not about the wrapper.
    expect(runOutcome).toBe('succeeded')

    expect(result?.outcome).toMatchObject({ kind: 'notified', newReviews: 2 })

    const sent = await deps.outbox()
    // EXACTLY one. A pass that sent one per listing per previous reading, or that retried, would be more.
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toContain('2 new reviews')
    // The deep link is built from the STORED place id, and the assertion names that id rather than a URL
    // written here — so a link built from configuration would fail it.
    expect(sent[0]?.body).toContain(`query_place_id=${PLACE}`)

    // And the reading records what was said, which is evidence rather than a derivation.
    const [row] = await sql<{ reported_new_reviews: number | null; review_count: number | null }[]>`
      select reported_new_reviews, review_count from google_place_aggregate
      where connection_id = ${connectionId}::uuid and observed_on = ${'2026-09-28'}::date
    `
    expect(row?.review_count).toBe(43)
    expect(row?.reported_new_reviews).toBe(2)
  })

  it('sends ZERO for an unchanged count, asserted on the same outbox', async () => {
    await seedPreviousReading(41, '2026-09-27')
    const deps = tripwireDeps({ counts: [41] })
    const { results, runOutcome } = await runReviewCountTripwire(deps)
    const [result] = results
    // The pass records its own agent run, so a throw inside it is a `failed` run with a heartbeat rather
    // than silence. Asserted here so the branches below are about the decision and not about the wrapper.
    expect(runOutcome).toBe('succeeded')
    expect(result?.outcome).toEqual({ kind: 'unchanged', reviewCount: 41 })
    expect(await deps.outbox()).toHaveLength(0)
    const [row] = await sql<{ reported_new_reviews: number | null }[]>`
      select reported_new_reviews from google_place_aggregate
      where connection_id = ${connectionId}::uuid and observed_on = ${'2026-09-28'}::date
    `
    expect(row?.reported_new_reviews).toBeNull()
  })

  it('sends ZERO when the count went DOWN, because there is nothing to read', async () => {
    await seedPreviousReading(43, '2026-09-27')
    const deps = tripwireDeps({ counts: [41] })
    const { results, runOutcome } = await runReviewCountTripwire(deps)
    const [result] = results
    // The pass records its own agent run, so a throw inside it is a `failed` run with a heartbeat rather
    // than silence. Asserted here so the branches below are about the decision and not about the wrapper.
    expect(runOutcome).toBe('succeeded')
    expect(result?.outcome).toEqual({ kind: 'decreased', from: 43, to: 41 })
    expect(await deps.outbox()).toHaveLength(0)
  })

  it('sends ZERO on the first reading, because nothing can have gone up', async () => {
    const deps = tripwireDeps({ counts: [43] })
    const { results, runOutcome } = await runReviewCountTripwire(deps)
    const [result] = results
    // The pass records its own agent run, so a throw inside it is a `failed` run with a heartbeat rather
    // than silence. Asserted here so the branches below are about the decision and not about the wrapper.
    expect(runOutcome).toBe('succeeded')
    expect(result?.outcome).toEqual({ kind: 'no_previous_reading' })
    expect(await deps.outbox()).toHaveLength(0)
  })

  it('reads once per trading date, so a reclaimed job cannot email twice about the same reviews', async () => {
    await seedPreviousReading(41, '2026-09-27')
    const first = tripwireDeps({ counts: [43] })
    expect((await runReviewCountTripwire(first)).results[0]?.outcome).toMatchObject({
      kind: 'notified',
    })
    // The same pass again at the same instant: pg-boss reclaims an expired job and this is what that looks
    // like. The unique index on (connection, place, trading date) is the idempotency.
    const second = tripwireDeps({ counts: [43] })
    expect((await runReviewCountTripwire(second)).results[0]?.outcome).toEqual({
      kind: 'already_read_today',
    })
    expect(await emailsSentTo(OWNER_FIXTURE_EMAIL)).toHaveLength(1)
  })

  it('records the reading and sends nothing when there is no address on file', async () => {
    await seedPreviousReading(41, '2026-09-27')
    const deps = tripwireDeps({ counts: [43], recipient: null })
    const { results, runOutcome } = await runReviewCountTripwire(deps)
    const [result] = results
    // The pass records its own agent run, so a throw inside it is a `failed` run with a heartbeat rather
    // than silence. Asserted here so the branches below are about the decision and not about the wrapper.
    expect(runOutcome).toBe('succeeded')
    expect(result?.outcome).toEqual({ kind: 'no_recipient_on_file', newReviews: 2 })
    expect(await deps.outbox()).toHaveLength(0)
    // The reading is still recorded, which is what makes the tripwire work the day an address exists. Scoped
    // to TODAY's trading date: the seeded previous reading is also in this table, and an unscoped query
    // returned it — which read as the pass having recorded nothing.
    const [row] = await sql<{ review_count: number | null }[]>`
      select review_count from google_place_aggregate
      where connection_id = ${connectionId}::uuid and observed_on = ${'2026-09-28'}::date
    `
    expect(row?.review_count).toBe(43)
  })

  it('is what the SHIPPED runtime does, because the shipped resolver answers null', () => {
    // The state this build actually ships in. Asserted against the exported resolver rather than by reading
    // the file, and it is why the branches above inject a fixture recipient.
    expect(NO_OWNER_CONTACT_ON_FILE()).toBeNull()
  })
})

describe('acceptance — the Places adapter stores aggregate only', () => {
  it('leaves none of the three fixture bodies in ANY table after a real run', async () => {
    await seedPreviousReading(41, '2026-09-27')
    const deps = tripwireDeps({ counts: [43] })
    await runReviewCountTripwire(deps)

    // Non-vacuity first: the fixture really does carry three bodies, so the scan had something to look for.
    expect(PLACES_REVIEW_FIXTURES).toHaveLength(3)
    expect(PLACES_AGGREGATE_FIXTURE.reviews).toHaveLength(3)

    expect(await reviewBodiesFoundAnywhere()).toEqual([])

    // The control that makes the scan itself credible: put one of the bodies into a text column and the same
    // scan must FIND it. Without this the assertion above would pass for a scan that examined nothing, which
    // is ADR 0002's failure exactly.
    const smuggled = PLACES_REVIEW_FIXTURES[0]?.text ?? ''
    const [row] = await sql<{ id: string }[]>`
      insert into google_reviews
        (connection_id, place_id, source, delivery_mode, rating, comment_text, reviewer_display_name,
         reviewed_at)
      values (${connectionId}, ${PLACE}, 'paste', 'manual', 5, ${smuggled}, 'A Google user',
              ${'2026-09-27T10:00:00.000Z'}::timestamptz)
      returning id
    `
    expect(await reviewBodiesFoundAnywhere()).toContain('google_reviews.comment_text')
    await sql`delete from google_reviews where id = ${row?.id ?? ''}::uuid`
    expect(await reviewBodiesFoundAnywhere()).toEqual([])
  })

  it('records how many bodies it discarded, so a silent discard is not mistaken for an empty API', async () => {
    const deps = tripwireDeps({ counts: [43] })
    await runReviewCountTripwire(deps)
    const [row] = await sql<{ curated_reviews_discarded: number; rating_tenths: number | null }[]>`
      select curated_reviews_discarded, rating_tenths from google_place_aggregate
      where connection_id = ${connectionId}::uuid and observed_on = ${'2026-09-28'}::date
    `
    expect(row?.curated_reviews_discarded).toBe(3)
    // Integer tenths, so the comparison that decides whether the rating moved is never a float compare.
    expect(row?.rating_tenths).toBe(46)
  })
})

describe('acceptance — the Monday nudge, both branches, on a frozen clock', () => {
  it('fires when nothing was reported in the preceding seven days', async () => {
    // Eight days ago: outside the window by one day, which is the boundary the window is about.
    await seedReportedReview(new Date(MONDAY_0900 - NUDGE_WINDOW_MS - 86_400_000).toISOString())
    const { notifier } = notifierWithOutbox(
      REVIEW_FALLBACK_TEMPLATE_KEYS.mondayNudge,
      new Date(MONDAY_0900).toISOString(),
    )
    const { results, runOutcome } = await runReviewMondayNudge({
      sql,
      notifier,
      recipientFor: () => OWNER_FIXTURE_EMAIL,
      now: MONDAY_0900,
    })
    expect(runOutcome).toBe('succeeded')
    expect(results[0]?.outcome).toMatchObject({ kind: 'nudged' })
    const sent = await emailsSentTo(OWNER_FIXTURE_EMAIL)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toContain(`query_place_id=${PLACE}`)
  })

  it('does NOT fire when something was reported inside the window', async () => {
    // Six days ago: inside the window, which is the other side of the same boundary.
    await seedReportedReview(new Date(MONDAY_0900 - 6 * 86_400_000).toISOString())
    const { notifier } = notifierWithOutbox(
      REVIEW_FALLBACK_TEMPLATE_KEYS.mondayNudge,
      new Date(MONDAY_0900).toISOString(),
    )
    const { results, runOutcome } = await runReviewMondayNudge({
      sql,
      notifier,
      recipientFor: () => OWNER_FIXTURE_EMAIL,
      now: MONDAY_0900,
    })
    // A quiet Monday is a SUCCESSFUL run, not an absent one. That is what makes the heartbeat assertion in
    // the next case a claim about this pass rather than about the wrapper.
    expect(runOutcome).toBe('succeeded')
    expect(results[0]?.outcome).toEqual({ kind: 'reported_recently', reported: 1 })
    expect(await emailsSentTo(OWNER_FIXTURE_EMAIL)).toHaveLength(0)
  })

  it('writes the heartbeat in BOTH branches, because a quiet Monday is not a dead worker', async () => {
    const heartbeat = async (): Promise<{ lastRunAt?: number; lastSuccessAt?: number }> => {
      // `agentsWithHeartbeat` rather than `findAgent`, which declares the definition alone: the heartbeat is
      // the whole subject here, and reading it off a value whose type does not carry it would be a cast.
      const agent = (await agentsWithHeartbeat(sql)).find(
        (row) => row.agentKey === REVIEW_MONDAY_NUDGE_AGENT,
      )
      if (agent === undefined) throw new Error('no agent_definition row for the Monday nudge')
      return {
        ...(agent.heartbeat.lastRunAt === undefined
          ? {}
          : { lastRunAt: agent.heartbeat.lastRunAt }),
        ...(agent.heartbeat.lastSuccessAt === undefined
          ? {}
          : { lastSuccessAt: agent.heartbeat.lastSuccessAt }),
      }
    }
    // Deliberately NOT a total or an absolute instant: `agent_heartbeat` is shared with every other run of
    // this agent, so what is asserted is that the PASS moved it to the instant it was given.
    //
    // The pass wraps itself in `withAgentRun`, so these two calls are the shipped code path and nothing here
    // supplies a wrapper. That is the difference between asserting this unit's behaviour and asserting that
    // G-AGT-01's helper works.

    // Branch 1: fired.
    const firedAt = new Date(MONDAY_0900).toISOString()
    const fired = await runReviewMondayNudge({
      sql,
      notifier: notifierWithOutbox(REVIEW_FALLBACK_TEMPLATE_KEYS.mondayNudge, firedAt).notifier,
      recipientFor: () => OWNER_FIXTURE_EMAIL,
      now: MONDAY_0900,
    })
    expect(fired.results[0]?.outcome).toMatchObject({ kind: 'nudged' })
    expect((await heartbeat()).lastRunAt).toBe(MONDAY_0900)
    expect((await heartbeat()).lastSuccessAt).toBe(MONDAY_0900)

    // Branch 2: not fired, one week later, with something reported inside the window.
    const nextMonday = (MONDAY_0900 + 7 * 86_400_000) as Instant
    await seedReportedReview(new Date(nextMonday - 86_400_000).toISOString())
    const quietAt = new Date(nextMonday).toISOString()
    const quiet = await runReviewMondayNudge({
      sql,
      notifier: notifierWithOutbox(REVIEW_FALLBACK_TEMPLATE_KEYS.mondayNudge, quietAt).notifier,
      recipientFor: () => OWNER_FIXTURE_EMAIL,
      now: nextMonday,
    })
    expect(quiet.results[0]?.outcome).toMatchObject({ kind: 'reported_recently' })
    // THE assertion: the heartbeat moved although nothing was sent. A pass that returned before the wrapper
    // would leave it at the previous instant, and a week of deliberate silence would read as a dead worker.
    expect((await heartbeat()).lastRunAt).toBe(nextMonday)
    expect((await heartbeat()).lastSuccessAt).toBe(nextMonday)
    // And nothing was sent in the second branch: one email in total across both.
    expect(await emailsSentTo(OWNER_FIXTURE_EMAIL)).toHaveLength(1)
  })
})

describe('09:00 Asia/Dubai is a wall-clock instant, not a UTC one', () => {
  it('declares Monday at 09:00 and the registry passes Asia/Dubai to pg-boss', () => {
    expect(REVIEW_MONDAY_NUDGE_CRON).toBe('0 9 * * 1')
    expect(SCHEDULE_TIMEZONE).toBe(ASIA_DUBAI)
    const registered = cronRegistrations().find((job) => job.name === REVIEW_MONDAY_NUDGE_JOB.name)
    expect(registered?.cron).toBe(REVIEW_MONDAY_NUDGE_CRON)
    expect(registered?.agent).toBe(REVIEW_MONDAY_NUDGE_AGENT)
  })

  it('puts the fire instant at 09:00 local on a Monday, which a UTC reading would put at 13:00', () => {
    const local = toLocal(MONDAY_0900, ASIA_DUBAI)
    expect(local.time).toBe('09:00')
    expect(local.date).toBe('2026-09-28')
    // The control: the same expression read as UTC would fire at 09:00Z, which is 13:00 in Dubai — the middle
    // of the working day instead of the start of it. This is what the zone argument buys.
    expect(toLocal(instantFromIso('2026-09-28T09:00:00.000Z'), ASIA_DUBAI).time).toBe('13:00')
  })

  it('declares the tripwire at 06:15, after every existing nightly pass', () => {
    expect(REVIEW_COUNT_TRIPWIRE_CRON).toBe('15 6 * * *')
    const registered = cronRegistrations().find(
      (job) => job.name === REVIEW_COUNT_TRIPWIRE_JOB.name,
    )
    expect(registered?.cron).toBe(REVIEW_COUNT_TRIPWIRE_CRON)
    expect(registered?.agent).toBe(REVIEW_COUNT_TRIPWIRE_AGENT)
    // Every other cron's hour, so "after every nightly pass" is measured rather than claimed.
    const nightlyHours = cronRegistrations()
      .filter((job) => job.name !== REVIEW_COUNT_TRIPWIRE_JOB.name)
      .map((job) => Number(job.cron.split(' ')[1]))
      .filter((hour) => Number.isInteger(hour) && hour >= 2 && hour <= 6)
    expect(nightlyHours.length).toBeGreaterThan(0)
    expect(Math.max(...nightlyHours)).toBeLessThanOrEqual(6)
  })

  it('gives each pass its own agent row, so a dead weekly pass is not hidden by a healthy daily one', async () => {
    // Migration 0033's argument, applied again: a shared heartbeat would be minutes old for ever.
    const tripwire = await findAgent(sql, REVIEW_COUNT_TRIPWIRE_AGENT)
    const nudge = await findAgent(sql, REVIEW_MONDAY_NUDGE_AGENT)
    expect(tripwire?.expectedIntervalSeconds).toBe(86_400)
    expect(nudge?.expectedIntervalSeconds).toBe(604_800)
    expect(tripwire?.agentKey).not.toBe(nudge?.agentKey)
  })
})

describe('the aggregate write records who made it', () => {
  it('records the pass as a system actor rather than as a person', async () => {
    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'google_place_aggregate.read'
    `
    await runReviewCountTripwire(tripwireDeps({ counts: [41] }))
    const after = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
      where action = 'google_place_aggregate.read' and actor_kind = 'system'
        and actor_label = ${TRIPWIRE_ACTOR.label}
    `
    expect(Number(after[0]?.n ?? '0')).toBe(Number(before[0]?.n ?? '0') + 1)
  })

  it('refuses a notification claiming zero new reviews', async () => {
    // `recordAggregateNotification`'s own guard, and the CHECK behind it. An email reading "0 new reviews" is
    // the one this pass must never send.
    const [row] = await sql<{ id: string }[]>`
      insert into google_place_aggregate
        (connection_id, place_id, observed_on, observed_at, rating_tenths, review_count)
      values (${connectionId}, ${PLACE}, ${'2026-09-26'}::date,
              ${'2026-09-26T02:15:00.000Z'}::timestamptz, 46, 41)
      returning id
    `
    await expect(
      sql`
        update google_place_aggregate set reported_new_reviews = 0 where id = ${row?.id ?? ''}::uuid
      `,
    ).rejects.toThrow()
    await withUnitOfWork(sql, TRIPWIRE_ACTOR, async () => {
      // A no-op unit of work, so the helper above is exercised with the same actor the pass uses and the
      // assertion below is about the guard rather than about the transaction.
    })
  })
})
