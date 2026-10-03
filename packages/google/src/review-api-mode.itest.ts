import { generateKek } from '@berelax/clinical'
import { ANONYMOUS_REVIEWER, fixedClock } from '@berelax/core'
import {
  createConnection,
  getReview,
  recordManualReview,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  REVIEW_FIXTURES,
  type Review,
} from '@berelax/providers/google'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { reviewsV4Limit } from './adapters/reviews-v4.ts'
import { createPostgresConnectionStore } from './postgres-store.ts'
import { simulatedRateLimitClock } from './rate-limit/token-bucket.ts'
import { deliverInStoredMode } from './reviews/api-mode.ts'
import { reconcileFirstSync } from './reviews/reconcile.ts'
import { createPostgresRefreshLock } from './token-refresh.ts'
import { connectionBinding, sealToken } from './token-store.ts'
import type { WithGoogleDeps } from './with-google.ts'

/**
 * G-REV-07 — the API path, against a real database: the flip, the first sync and the degradation.
 *
 * Four claims, and none of them can be made without a database:
 *
 *   1. **The flip is a row change.** `delivery_mode` is UPDATEd from `manual` to `api` mid-test and the
 *      next reply goes out through the v4 adapter — no restart, no redeploy, no code change.
 *   2. **The first sync matches by reviewer name, rating and date and backfills in place.** Three pasted
 *      rows and four API reviews must leave exactly FOUR rows, which is a count no unit test can make.
 *   3. **An ambiguous match writes nothing.** Two star-only five-star reviews from the same anonymous
 *      reviewer on one day is an ordinary Saturday, and picking one would attach the id to the wrong draft.
 *   4. **`quota_exhausted` and `access_not_granted` degrade and do not throw**, leaving an owner-visible
 *      row behind — which is a `health_check_failed` connection event and a capability health, both written
 *      by `withGoogle` rather than by a second degradation path in this unit.
 *
 * ## Why it is one directory up from `reviews/`
 *
 * `reviews-generator-must-not-reach-clinical-data` forbids every module under
 * `packages/google/src/reviews/` from importing `@berelax/clinical`, with no test exemption and for a
 * stated reason — a clinical type there is the shape of a field somebody intends to interpolate into a
 * prompt. This file needs `generateKek` to seal a REAL refresh token, because the api arm refreshes one
 * under the advisory lock and a stand-in ciphertext would make every degradation assertion below pass
 * because the token died rather than because the quota did. So it sits beside `review-queue.itest.ts` and
 * `review-routing.itest.ts`, which are one directory up for reasons of their own, rather than carving an
 * exemption into a rule whose value is that it has none.
 *
 * ## Isolation
 *
 * One connection, created here, and every row this file writes hangs off it. The deletes in `afterAll`
 * are ordered reviews-then-connection, because `google_reviews.connection_id` is ON DELETE RESTRICT and a
 * leftover review makes a later file's connection delete fail on a constraint that has nothing to do with
 * it — the trap `reply-delivery.itest.ts` records one directory along.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const KEK = generateKek('v1')
const SUB = 'sub-grev07-api-mode'
const REFRESH_TOKEN = '1//09-grev07-api-mode-refresh-token-never-in-a-row'
const NOW_ISO = '2026-10-02T06:00:00.000Z'
const OWNER = { kind: 'staff', id: '66666666-6666-6666-6666-666666666666', label: 'Owner' } as const
/** Visibly a fixture (the brief's rule 15), and a listing no other suite writes. */
const PLACE = 'ChIJ_grev07_api_mode_place'
const ACCOUNT = 'accounts/grev07-location-group'
const LOCATION = 'locations/grev07-al-zahiyah'
const CLEAN = 'Thank you for the feedback. We look forward to welcoming you back.'
/**
 * The instant the pasted rows and the API reviews agree on — deliberately AFTER 20:00 UTC.
 *
 * `reconcileApiReviewId` matches on `(reviewed_at at time zone $zone)::date`, so the zone is only
 * load-bearing when the UTC date and the Asia/Dubai date DIFFER. 21:30 UTC is 01:30 the next day in
 * Dubai, which is also an ordinary trading hour here (docs/13 §2: 11:00-02:00). A mid-afternoon instant
 * would make the two dates equal and every assertion below would pass with the zone dropped entirely —
 * which gate case 173o found by dropping it and watching nothing fail.
 */
const REVIEWED_AT = '2026-09-20T21:30:00.000Z'
/**
 * Review ids the FAKE knows about.
 *
 * `updateReply` on the fake refuses an id it has never seen, the way the real API answers 404 for a
 * review that is not on the listing — so an api-mode delivery has to name a review that exists. Taken
 * from `REVIEW_FIXTURES` rather than invented, which is also what makes the refusal above meaningful:
 * the v1-shaped-ref case has to fail for its OWN reason and not because the id was made up.
 */
const FAKE_REVIEW_IDS = REVIEW_FIXTURES.map((review) => review.reviewId)

let sql: Sql
let connectionId = ''

async function seedConnection(resourceRef: {
  readonly account?: string
  readonly location: string
  readonly placeId: string
}): Promise<string> {
  // A connection id is needed to BIND the sealed token, and the token is needed on the row — so the row
  // is inserted with a placeholder ciphertext and the real sealed token written immediately after. The
  // real one matters: a stand-in fails the refresh, and every degradation assertion below would then pass
  // because the token died rather than because the quota did.
  const ct = Buffer.from('ciphertext-stand-in')
  const [connection] = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp, consent_at, status)
    values (${SUB}, ${'owner@berelax.ae'},
            ${sql.array(['https://www.googleapis.com/auth/business.manage'])},
            ${ct}, ${ct}, ${ct}, 'v1', 'fp-stand-in', ${NOW_ISO}::timestamptz, 'active')
    returning id
  `
  const id = connection?.id ?? ''
  const sealed = sealToken(
    KEK,
    connectionBinding({ connectionId: id, googleSub: SUB }),
    REFRESH_TOKEN,
  )
  await sql`
    update google_connections set
      refresh_token_ct = ${sealed.ct},
      refresh_token_nonce = ${sealed.nonce},
      refresh_token_wrapped_key = ${sealed.wrappedKey},
      refresh_token_kid = ${sealed.kid},
      refresh_token_aad_fp = ${sealed.aadFingerprint}
    where id = ${id}
  `
  await sql`
    insert into google_capabilities (connection_id, capability, resource_ref, health, is_primary)
    values (${id}, 'gbp_reviews', ${sql.json({ ...resourceRef })}, 'unknown', true)
  `
  return id
}

/** A pasted review: no `google_review_id`, which on launch day is every row (docs/10 §6 decision 1). */
async function pasted(args: {
  readonly rating?: number
  readonly comment?: string | null
  readonly reviewerDisplayName?: string
  readonly reviewedAtIso?: string
}): Promise<string> {
  const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
    recordManualReview(uow, {
      connectionId,
      placeId: PLACE,
      source: 'paste',
      rating: args.rating ?? 5,
      comment: args.comment ?? null,
      reviewerDisplayName: args.reviewerDisplayName ?? ANONYMOUS_REVIEWER,
      reviewedAtIso: args.reviewedAtIso ?? REVIEWED_AT,
    }),
  )
  return id
}

interface Harness {
  readonly google: WithGoogleDeps
  readonly profile: ReturnType<typeof createFakeBusinessProfile>
  readonly apiFailures: FailureScript
  readonly replies: { readonly locationId: string; readonly reviewId: string }[]
}

function harness(): Harness {
  const log = createCallLog(() => NOW_ISO)
  const apiFailures = new FailureScript()
  const store = createPostgresConnectionStore(sql)
  const profile = createFakeBusinessProfile({
    log,
    failures: apiFailures,
    now: () => NOW_ISO,
  })
  const replies: { locationId: string; reviewId: string }[] = []
  const spied = {
    ...profile,
    async updateReply(args: { locationId: string; reviewId: string; comment: string }) {
      // Recorded BEFORE the call, so a failing call is still evidence the path was taken.
      replies.push({ locationId: args.locationId, reviewId: args.reviewId })
      await profile.updateReply(args)
    },
  }
  return {
    profile: spied as ReturnType<typeof createFakeBusinessProfile>,
    apiFailures,
    replies,
    google: {
      store,
      lock: createPostgresRefreshLock(sql),
      oauth: createFakeGoogleOAuth({
        log,
        failures: new FailureScript(),
        now: () => NOW_ISO,
        sub: SUB,
      }),
      kek: KEK,
      clock: fixedClock(NOW_ISO),
      logger: { log: () => {} },
    },
  }
}

const apiReview = (overrides: Partial<Review> & { readonly reviewId: string }): Review => ({
  rating: 5,
  reviewerDisplayName: ANONYMOUS_REVIEWER,
  createdAtIso: REVIEWED_AT,
  ...overrides,
})

async function countReviews(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from google_reviews where connection_id = ${connectionId}
  `
  return Number(row?.n)
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  await sql`delete from google_reviews where place_id = ${PLACE}`
  await sql`delete from google_connections where google_sub = ${SUB}`
  connectionId = await seedConnection({ account: ACCOUNT, location: LOCATION, placeId: PLACE })
})

beforeEach(async () => {
  await sql`delete from google_reviews where connection_id = ${connectionId}`
})

afterAll(async () => {
  // Reviews before connections: the foreign key is ON DELETE RESTRICT.
  await sql`delete from google_reviews where connection_id = ${connectionId}`
  await sql`delete from google_connections where google_sub = ${SUB}`
  await sql.end({ timeout: 5 })
})

describe('the legacy v4 API delivery mode', () => {
  it('delivers through the API path after delivery_mode is flipped mid-test, with no restart', async () => {
    const h = harness()
    const limit = reviewsV4Limit(simulatedRateLimitClock())
    const reviewId = await pasted({ comment: 'Lovely visit.' })

    // A row the first sync has matched, so there is something on the listing to reply to.
    await sql`
      update google_reviews
      set google_review_id = ${`${ACCOUNT}/${LOCATION}/reviews/flip-1`},
          google_update_time = ${NOW_ISO}::timestamptz,
          reconciled_at = now()
      where id = ${reviewId}
    `

    // Before the flip: manual. The reply is delivered by the fallback path and reaches no transport.
    expect((await getReview(sql, reviewId))?.deliveryMode).toBe('manual')
    const manual = await deliverInStoredMode(
      { sql, actor: OWNER, google: h.google, profile: h.profile, limit },
      { reviewId, approvedReply: CLEAN, language: 'en' },
    )
    expect(manual.kind).toBe('delivered')
    expect(h.replies).toHaveLength(0)
    expect((await getReview(sql, reviewId))?.postedManuallyAtIso).not.toBeNull()

    // THE FLIP. One UPDATE, no deploy. A fresh row, because the constraint
    // `google_reviews_delivery_fields_match_mode` refuses a row carrying a manual timestamp in api mode —
    // which is the database saying the same thing: a delivery already happened by the other path.
    const second = await pasted({ comment: 'Came back again.' })
    await sql`
      update google_reviews
      set delivery_mode = 'api',
          google_review_id = ${FAKE_REVIEW_IDS[1] as string},
          google_update_time = ${NOW_ISO}::timestamptz,
          reconciled_at = now()
      where id = ${second}
    `
    expect((await getReview(sql, second))?.deliveryMode).toBe('api')

    // The SAME function, the same process, the same deps.
    const api = await deliverInStoredMode(
      { sql, actor: OWNER, google: h.google, profile: h.profile, limit },
      { reviewId: second, approvedReply: CLEAN, language: 'en' },
    )
    expect(api.kind).toBe('delivered')
    expect(h.replies).toHaveLength(1)
    // The v4 path, built from the PERSISTED account. This is what the accountId is stored for.
    expect(h.replies[0]?.locationId).toBe(
      `https://mybusiness.googleapis.com/v4/${ACCOUNT}/${LOCATION}/reviews/${encodeURIComponent(FAKE_REVIEW_IDS[1] as string)}/reply`,
    )
    const row = await getReview(sql, second)
    expect(row?.submittedAtIso).not.toBeNull()
    expect(row?.postedManuallyAtIso).toBeNull()
  })

  it('backfills three pasted rows, inserts one new review, and leaves exactly four rows', async () => {
    const h = harness()
    void h
    const first = await pasted({ rating: 5, comment: 'One.', reviewerDisplayName: 'Reviewer One' })
    const secondId = await pasted({
      rating: 4,
      comment: 'Two.',
      reviewerDisplayName: 'Reviewer Two',
    })
    const thirdId = await pasted({
      rating: 3,
      comment: null,
      reviewerDisplayName: 'Reviewer Three',
    })
    expect(await countReviews()).toBe(3)

    const result = await reconcileFirstSync(
      { sql, actor: { kind: 'agent', label: 'review_autoresponder' } },
      {
        connectionId,
        placeId: PLACE,
        reviews: [
          apiReview({
            reviewId: 'rv-1',
            rating: 5,
            reviewerDisplayName: 'Reviewer One',
            comment: 'One.',
          }),
          apiReview({
            reviewId: 'rv-2',
            rating: 4,
            reviewerDisplayName: 'Reviewer Two',
            comment: 'Two.',
          }),
          apiReview({ reviewId: 'rv-3', rating: 3, reviewerDisplayName: 'Reviewer Three' }),
          // The one nothing matches: a review the owner never pasted.
          apiReview({
            reviewId: 'rv-4',
            rating: 2,
            reviewerDisplayName: 'Reviewer Four',
            comment: 'Four.',
          }),
        ],
      },
    )

    expect(result.backfilled).toBe(3)
    expect(result.inserted).toBe(1)
    expect(result.ambiguous).toEqual([])
    // THE count the acceptance line names: four rows, zero duplicates.
    expect(await countReviews()).toBe(4)

    // Backfilled IN PLACE: the same rows, now carrying ids, with their drafts and delivery history intact.
    for (const [id, googleReviewId] of [
      [first, 'rv-1'],
      [secondId, 'rv-2'],
      [thirdId, 'rv-3'],
    ] as const) {
      const row = await getReview(sql, id)
      expect(row?.googleReviewId).toBe(googleReviewId)
      // Still a pasted row. The source is the provenance of the TEXT and reconciliation does not rewrite
      // history — which is why an id can be present on a row whose source is `paste` (0020's own comment).
      expect(row?.source).toBe('paste')
    }

    // And a re-run of the sync changes nothing, which is what makes a first sync safe to repeat.
    const again = await reconcileFirstSync(
      { sql, actor: { kind: 'agent', label: 'review_autoresponder' } },
      {
        connectionId,
        placeId: PLACE,
        reviews: [
          apiReview({
            reviewId: 'rv-1',
            rating: 5,
            reviewerDisplayName: 'Reviewer One',
            comment: 'One.',
          }),
          apiReview({
            reviewId: 'rv-4',
            rating: 2,
            reviewerDisplayName: 'Reviewer Four',
            comment: 'Four.',
          }),
        ],
      },
    )
    expect(again.backfilled).toBe(0)
    expect(again.inserted).toBe(0)
    expect(again.unchanged).toBe(2)
    expect(await countReviews()).toBe(4)
  })

  it('writes nothing for an ambiguous match and carries the candidates out', async () => {
    // Two star-only five-star reviews from the same anonymous reviewer on one day: an ordinary Saturday.
    const a = await pasted({ rating: 5, comment: null })
    const b = await pasted({ rating: 5, comment: null })
    expect(await countReviews()).toBe(2)

    const result = await reconcileFirstSync(
      { sql, actor: { kind: 'agent', label: 'review_autoresponder' } },
      { connectionId, placeId: PLACE, reviews: [apiReview({ reviewId: 'rv-ambiguous' })] },
    )

    expect(result.backfilled).toBe(0)
    expect(result.inserted).toBe(0)
    expect(result.ambiguous).toHaveLength(1)
    expect(result.ambiguous[0]?.candidateIds.slice().sort()).toEqual([a, b].sort())
    // Nothing written: neither row acquired an id, and no third row appeared.
    expect(await countReviews()).toBe(2)
    expect((await getReview(sql, a))?.googleReviewId).toBeNull()
    expect((await getReview(sql, b))?.googleReviewId).toBeNull()
  })

  it('degrades to draft_only on quota-zero and on access_not_granted, without throwing', async () => {
    for (const mode of ['quota_exhausted', 'access_not_granted'] as const) {
      await sql`delete from google_reviews where connection_id = ${connectionId}`
      const h = harness()
      const limit = reviewsV4Limit(simulatedRateLimitClock())
      const reviewId = await pasted({ comment: 'A visit.' })
      await sql`
        update google_reviews
        set delivery_mode = 'api',
            google_review_id = ${FAKE_REVIEW_IDS[2] as string},
            google_update_time = ${NOW_ISO}::timestamptz,
            reconciled_at = now()
        where id = ${reviewId}
      `
      const before = await sql<{ n: string }[]>`
        select count(*)::text as n from google_connection_events
        where connection_id = ${connectionId} and event = 'health_check_failed'
      `
      h.apiFailures.failAlways(mode)

      // It RETURNS. docs/10 §6: the fallback is the launch mode, not an error state.
      const outcome = await deliverInStoredMode(
        { sql, actor: OWNER, google: h.google, profile: h.profile, limit },
        { reviewId, approvedReply: CLEAN, language: 'en' },
      )
      expect(outcome.kind, mode).toBe('degraded')
      if (outcome.kind !== 'degraded') return
      // The DECLARED mode from the consumers table, not a decision taken in the delivery path.
      expect(outcome.mode, mode).toBe('draft_only')
      expect(outcome.cause, mode).toBe(
        mode === 'quota_exhausted' ? 'QuotaZero' : 'AccessNotGranted',
      )

      // Nothing was delivered: no timestamp on the row.
      const row = await getReview(sql, reviewId)
      expect(row?.submittedAtIso, mode).toBeNull()
      expect(row?.postedManuallyAtIso, mode).toBeNull()
      // But the draft survives, which is what `draft_only` means.
      expect(row?.replyApprovedText, mode).toBeNull()

      // The owner-visible row. A DELTA, never a total: other suites write to this table too.
      const after = await sql<{ n: string }[]>`
        select count(*)::text as n from google_connection_events
        where connection_id = ${connectionId} and event = 'health_check_failed'
      `
      expect(Number(after[0]?.n) - Number(before[0]?.n), mode).toBeGreaterThanOrEqual(1)

      const [capability] = await sql<{ health: string }[]>`
        select health from google_capabilities
        where connection_id = ${connectionId} and capability = 'gbp_reviews'
      `
      // `quota_zero` for BOTH, and that is `capabilityHealthFor`'s own decision rather than a
      // simplification here: an unapproved application and an exhausted quota are both "a valid token
      // with no quota behind it", which is what the panel renders as *Business Profile access pending
      // Google approval* (docs/10 §4). The CAUSE is what distinguishes them, and it is asserted above.
      expect(capability?.health, mode).toBe('quota_zero')
      await sql`
        update google_capabilities set health = 'unknown'
        where connection_id = ${connectionId} and capability = 'gbp_reviews'
      `
    }
  })

  it('returns a lint refusal as a refusal, not as an upstream Google failure', async () => {
    const h = harness()
    const limit = reviewsV4Limit(simulatedRateLimitClock())
    const reviewId = await pasted({ comment: 'A visit.' })
    await sql`
      update google_reviews
      set delivery_mode = 'api',
          google_review_id = ${FAKE_REVIEW_IDS[4] as string},
          google_update_time = ${NOW_ISO}::timestamptz,
          reconciled_at = now()
      where id = ${reviewId}
    `

    // A reply the send-path linter refuses. The approved text names a therapist's display name, which is
    // the rule docs/10 §6 lists first; the text itself comes from nothing invented here.
    const outcome = await deliverInStoredMode(
      { sql, actor: OWNER, google: h.google, profile: h.profile, limit },
      {
        reviewId,
        approvedReply: 'Thank you. We will tell the team you mentioned how pleased you were.cure',
        language: 'en',
      },
    )

    // A REFUSAL with the rules named, and NOT a degraded outcome or a thrown Google error. Without the
    // discrimination in `api-mode.ts`, `classifyGoogleError` files this as `TransientUpstream` — which
    // does not degrade — and the owner is handed a correlation id instead of the rule to fix.
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.rules.length).toBeGreaterThan(0)
    // Nothing was submitted and nothing was stamped.
    expect(h.replies).toHaveLength(0)
    expect(limit.admitted).toHaveLength(0)
    const row = await getReview(sql, reviewId)
    expect(row?.submittedAtIso).toBeNull()
    expect(row?.replyLintVersion).toBeNull()
  })

  it('refuses an api-mode delivery against a v1-shaped capability row, with zero transport calls', async () => {
    const h = harness()
    const limit = reviewsV4Limit(simulatedRateLimitClock())
    const reviewId = await pasted({ comment: 'A visit.' })
    await sql`
      update google_reviews
      set delivery_mode = 'api',
          google_review_id = ${`${ACCOUNT}/${LOCATION}/reviews/v1-shaped`},
          google_update_time = ${NOW_ISO}::timestamptz,
          reconciled_at = now()
      where id = ${reviewId}
    `
    // The row a v1-only client would have written: a location, and nothing to build a v4 path from.
    await sql`
      update google_capabilities set resource_ref = ${sql.json({ location: LOCATION, placeId: PLACE })}
      where connection_id = ${connectionId} and capability = 'gbp_reviews'
    `
    try {
      await expect(
        deliverInStoredMode(
          { sql, actor: OWNER, google: h.google, profile: h.profile, limit },
          { reviewId, approvedReply: CLEAN, language: 'en' },
        ),
      ).rejects.toThrow()
      expect(h.replies).toHaveLength(0)
      expect(limit.admitted).toHaveLength(0)
      expect((await getReview(sql, reviewId))?.submittedAtIso).toBeNull()
    } finally {
      await sql`
        update google_capabilities
        set resource_ref = ${sql.json({ account: ACCOUNT, location: LOCATION, placeId: PLACE })},
            health = 'unknown'
        where connection_id = ${connectionId} and capability = 'gbp_reviews'
      `
    }
  })

  it('registers the quarterly changelog obligation in the compliance calendar', async () => {
    // Migration 0145's row. Queried by RECURRENCE, which is what the acceptance line asks for: a duty
    // with no cadence is a note, and docs/10 §8 asks for a recurring reminder.
    const [row] = await sql<
      {
        cadence: string
        obligationClass: string
        ownerRole: string
        isBlocking: boolean
        evidenceRequired: boolean
        isUnverified: boolean
      }[]
    >`
      select cadence, obligation_class as "obligationClass", owner_role as "ownerRole",
             is_blocking as "isBlocking", evidence_required as "evidenceRequired",
             is_unverified as "isUnverified"
      from obligation where key = 'business_profile_api_changelog_review'
    `
    expect(row?.cadence).toBe('quarterly')
    expect(row?.obligationClass).toBe('operational')
    expect(row?.ownerRole).toBe('owner')
    // Not blocking: an unread changelog does not stop the premises trading or publishing.
    expect(row?.isBlocking).toBe(false)
    // Evidence required: the question it answers later is "did we know", and a tick in a box would not.
    expect(row?.evidenceRequired).toBe(true)
    // NOT unverified: that flag means the duty itself is our reading of a secondary source, and this one
    // is stated in the imperative in docs/10 §8.
    expect(row?.isUnverified).toBe(false)
  })
})
