import {
  createConnection,
  getReview,
  ingestApiReview,
  listReviewQueue,
  reconcileApiReviewId,
  recordManualReview,
  recordReplyConfirmedByGoogle,
  recordReplyPostedManually,
  recordReplySubmittedToApi,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { REVIEW_FIXTURES, type Review } from '@berelax/providers/google'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * G-REV-01 — the review queue's two paths, against a real database and the real review fixtures.
 *
 * It lives in `packages/google` because it exercises a *pair*: `@berelax/db`'s review repository and
 * the fake Google provider's `REVIEW_FIXTURES`. This is the package that already depends on both, the
 * same reason `google-connection.itest.ts` lives here; `packages/db` depends on `@berelax/shared` and
 * nothing else, and a test is not a licence to widen that.
 *
 * **Every reviewer label here comes from `REVIEW_FIXTURES`**, including on the pasted rows — which is
 * both the rule (no invented names of people) and the only honest choice: a pasted review's reviewer
 * name is copied from Google's own notification, and reconciliation later matches on the name Google
 * reports. A name invented here would let the test agree with itself.
 *
 * `REVIEW_FIXTURES` is imported from `@berelax/providers/google` rather than the package barrel: the
 * barrel re-exports the SMS and email ports, and `messaging-providers-only-inside-a-transport` forbids
 * reaching it from outside a transport.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const OWNER = { kind: 'staff', id: '55555555-5555-5555-5555-555555555555', label: 'Owner' } as const
const PLACE = 'ChIJ_berelax_fixture_place'
const OTHER_PLACE = 'ChIJ_other_listing_fixture'
/** The zone is always an argument. Asia/Dubai is where the listing is, and where the date is read. */
const ZONE = 'Asia/Dubai'
const CT = Buffer.from('ciphertext-stand-in')
/** Google's placeholder for a reviewer who left no name, and what the API actually returns. */
const ANONYMOUS = 'A Google user'

let sql: Sql
let connectionId = ''
let otherConnectionId = ''

/** Looks a fixture up by id so a test names the case it means rather than an array index. */
function fixture(reviewId: string): Review {
  const found = REVIEW_FIXTURES.find((review) => review.reviewId === reviewId)
  if (found === undefined) throw new Error(`No review fixture ${reviewId}`)
  return found
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

/**
 * `audit_event` is append-only (ADR 0008), so every assertion about it here is a **delta**. A total
 * would be a different number on the second run of the suite and a different number again in CI.
 */
async function auditCount(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where entity_type = 'google_review'
  `
  return Number(row?.n ?? '0')
}

async function reviewCount(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from google_reviews`
  return Number(row?.n ?? '0')
}

beforeAll(() => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  // Reviews before connections: the foreign key is ON DELETE RESTRICT, so leaving a review behind
  // would fail the next file's connection cleanup on a constraint unrelated to whatever it is testing.
  await sql`delete from google_reviews`
  await sql`delete from google_connections`
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from google_reviews`
  await sql`delete from google_connections`
  connectionId = await seedConnection('sub-review-queue', PLACE)
  otherConnectionId = await seedConnection('sub-second-listing', OTHER_PLACE)
})

function apiPayload(reviewId: string, updateTimeIso: string) {
  const review = fixture(reviewId)
  return {
    connectionId,
    placeId: PLACE,
    googleReviewId: review.reviewId,
    updateTimeIso,
    rating: review.rating,
    comment: review.comment ?? null,
    reviewerDisplayName: review.reviewerDisplayName,
    reviewedAtIso: review.createdAtIso,
  }
}

describe('acceptance — at-least-once delivery is replayed, not duplicated', () => {
  it('yields exactly one review row and one audit_event for a replayed payload', async () => {
    // Pub/Sub notification delivery is at-least-once (docs/10 §7): the same payload arriving twice is
    // normal traffic, not a fault, and the second one must change nothing.
    const payload = apiPayload('rev-5-en', '2026-09-10T18:30:00.000Z')
    const auditBefore = await auditCount()

    const first = await withUnitOfWork(sql, OWNER, (uow) => ingestApiReview(uow, payload))
    const second = await withUnitOfWork(sql, OWNER, (uow) => ingestApiReview(uow, payload))

    expect(first.outcome).toBe('inserted')
    expect(second.outcome).toBe('unchanged')
    expect(second.id).toBe(first.id)
    expect(await reviewCount()).toBe(1)
    // A delta, never a total: audit_event is append-only and this suite shares it with every other file.
    expect((await auditCount()) - auditBefore).toBe(1)
  })

  it('still records a genuinely newer update_time, which is what makes the replay test mean something', async () => {
    // The control. If `ingestApiReview` deduplicated on the review id alone, the test above would pass
    // and an edited review would silently never update. The key is the pair.
    const auditBefore = await auditCount()
    const first = await withUnitOfWork(sql, OWNER, (uow) =>
      ingestApiReview(uow, apiPayload('rev-3-mixed', '2026-09-13T15:20:00.000Z')),
    )
    const edited = {
      ...apiPayload('rev-3-mixed', '2026-09-14T09:00:00.000Z'),
      comment: 'Updated: the manager called me and sorted it out.',
    }
    const second = await withUnitOfWork(sql, OWNER, (uow) => ingestApiReview(uow, edited))

    expect(second.outcome).toBe('updated')
    expect(second.id).toBe(first.id)
    expect(await reviewCount()).toBe(1)
    expect((await auditCount()) - auditBefore).toBe(2)
    const stored = await getReview(sql, first.id)
    expect(stored?.comment).toBe(edited.comment)
  })

  it('refuses to replay an older update_time over a newer one', async () => {
    // Out-of-order delivery is the other half of at-least-once. The stale payload must not win.
    const fresh = apiPayload('rev-2-names-staff', '2026-09-14T13:00:00.000Z')
    const stale = {
      ...apiPayload('rev-2-names-staff', '2026-09-14T12:35:00.000Z'),
      comment: 'stale',
    }
    const inserted = await withUnitOfWork(sql, OWNER, (uow) => ingestApiReview(uow, fresh))
    const replayed = await withUnitOfWork(sql, OWNER, (uow) => ingestApiReview(uow, stale))

    expect(replayed.outcome).toBe('unchanged')
    const stored = await getReview(sql, inserted.id)
    expect(stored?.comment).toBe(fixture('rev-2-names-staff').comment)
  })
})

describe('acceptance — a star-only review is an ordinary row', () => {
  it('stores a star-only fixture with comment NULL and a texted one verbatim', async () => {
    const starOnly = fixture('rev-1-star-only')
    expect(starOnly.comment).toBeUndefined() // the fixture is the case, not a contrivance

    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      ingestApiReview(uow, apiPayload('rev-1-star-only', '2026-09-16T00:00:00.000Z')),
    )
    const stored = await getReview(sql, id)
    expect(stored?.rating).toBe(1)
    expect(stored?.comment).toBeNull()

    // The control: a review that does have text keeps it exactly, so the NULL above is the star-only
    // case rather than the comment being dropped on every path.
    const { id: withText } = await withUnitOfWork(sql, OWNER, (uow) =>
      ingestApiReview(uow, apiPayload('rev-5-en', '2026-09-10T18:30:00.000Z')),
    )
    expect((await getReview(sql, withText))?.comment).toBe(fixture('rev-5-en').comment)
  })

  it('records a pasted star-only review, with no id and manual delivery', async () => {
    // The launch-mode intake: the owner saw a rating and no text, and typed in what Google showed —
    // which for a star-only review is usually 'A Google user' and never a name we could invent.
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      recordManualReview(uow, {
        connectionId,
        placeId: PLACE,
        source: 'paste',
        rating: 5,
        comment: '   ', // an empty textarea, which is a star-only review and not an empty comment
        reviewerDisplayName: ANONYMOUS,
        reviewedAtIso: '2026-09-17T09:00:00.000Z',
      }),
    )
    const stored = await getReview(sql, id)
    expect(stored?.googleReviewId).toBeNull()
    expect(stored?.deliveryMode).toBe('manual')
    expect(stored?.source).toBe('paste')
    expect(stored?.comment).toBeNull()
    expect(stored?.reviewerDisplayName).toBe(ANONYMOUS)
  })
})

describe('acceptance — reconciliation backfills the row, it does not add one', () => {
  /** A pasted review that has been drafted, approved and posted by hand: the launch-mode lifecycle. */
  async function pasteAndPost(source: Review, draft: string): Promise<string> {
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      recordManualReview(uow, {
        connectionId,
        placeId: PLACE,
        source: 'paste',
        rating: source.rating,
        comment: source.comment ?? null,
        reviewerDisplayName: source.reviewerDisplayName,
        reviewedAtIso: source.createdAtIso,
      }),
    )
    await sql`update google_reviews set reply_draft = ${draft} where id = ${id}`
    await withUnitOfWork(sql, OWNER, (uow) => recordReplyPostedManually(uow, id))
    return id
  }

  it('matches on reviewer name, rating and date and keeps the row, the draft and the history', async () => {
    const review = fixture('rev-1-star-only')
    const draft =
      'Thank you for the rating. Please contact us so we can understand what went wrong.'
    const pasted = await pasteAndPost(review, draft)
    const auditBefore = await auditCount()

    // 2026-09-15T23:58Z is 2026-09-16 in Asia/Dubai, and the Dubai date is the one Google shows the
    // owner. Reconciling on the UTC date would miss every review left after 20:00 local.
    const outcome = await withUnitOfWork(sql, OWNER, (uow) =>
      reconcileApiReviewId(uow, {
        connectionId,
        placeId: PLACE,
        googleReviewId: review.reviewId,
        updateTimeIso: '2026-09-16T04:00:00.000Z',
        reviewerDisplayName: review.reviewerDisplayName,
        rating: review.rating,
        reviewedOn: '2026-09-16',
        zone: ZONE,
      }),
    )

    expect(outcome).toEqual({ kind: 'backfilled', id: pasted })
    expect(await reviewCount()).toBe(1) // backfilled, not inserted alongside

    const stored = await getReview(sql, pasted)
    expect(stored?.googleReviewId).toBe(review.reviewId)
    expect(stored?.replyDraft).toBe(draft) // the draft is the work; reconciliation must not touch it
    expect(stored?.deliveryMode).toBe('manual') // the delivery history survives the backfill
    expect(stored?.postedManuallyAtIso).not.toBeNull()
    expect(stored?.submittedAtIso).toBeNull()
    expect((await auditCount()) - auditBefore).toBe(1)

    // And the API can now address the row it could not see before, without re-creating it.
    const ingested = await withUnitOfWork(sql, OWNER, (uow) =>
      ingestApiReview(uow, apiPayload('rev-1-star-only', '2026-09-16T05:00:00.000Z')),
    )
    expect(ingested.id).toBe(pasted)
    expect(await reviewCount()).toBe(1)
    // Even the API ingest leaves the delivery history alone: it is authoritative about the review,
    // and knows nothing about who posted the reply.
    expect((await getReview(sql, pasted))?.deliveryMode).toBe('manual')
  })

  it('does not match on the wrong date, the wrong rating or another connection', async () => {
    // Three controls on the match above. Each of them would be a silent mis-attribution: the id of
    // one review written onto another review's row, taking every later API reply with it.
    const review = fixture('rev-1-star-only')
    const pasted = await pasteAndPost(review, 'draft')
    const base = {
      connectionId,
      placeId: PLACE,
      googleReviewId: review.reviewId,
      updateTimeIso: '2026-09-16T04:00:00.000Z',
      reviewerDisplayName: review.reviewerDisplayName,
      rating: review.rating,
      reviewedOn: '2026-09-16',
      zone: ZONE,
    }
    const auditBefore = await auditCount()

    // The UTC date rather than the Dubai one.
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        reconcileApiReviewId(uow, { ...base, reviewedOn: '2026-09-15' }),
      ),
    ).resolves.toEqual({ kind: 'no_match' })
    await expect(
      withUnitOfWork(sql, OWNER, (uow) => reconcileApiReviewId(uow, { ...base, rating: 5 })),
    ).resolves.toEqual({ kind: 'no_match' })
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        reconcileApiReviewId(uow, {
          ...base,
          connectionId: otherConnectionId,
          placeId: OTHER_PLACE,
        }),
      ),
    ).resolves.toEqual({ kind: 'no_match' })

    expect((await getReview(sql, pasted))?.googleReviewId).toBeNull()
    expect((await auditCount()) - auditBefore).toBe(0)
  })

  it('reports ambiguity rather than guessing between two identical-looking reviews', async () => {
    // Two star-only four-star reviews from 'A Google user' on one day is an ordinary Saturday, and
    // reviewer name + rating + date is everything Google gives us. Guessing would attach the id to the
    // wrong draft, and nothing downstream would ever notice.
    const review = fixture('rev-4-star-only')
    const one = await pasteAndPost(review, 'draft one')
    const two = await pasteAndPost(review, 'draft two')
    const auditBefore = await auditCount()

    const outcome = await withUnitOfWork(sql, OWNER, (uow) =>
      reconcileApiReviewId(uow, {
        connectionId,
        placeId: PLACE,
        googleReviewId: review.reviewId,
        updateTimeIso: '2026-09-13T04:00:00.000Z',
        reviewerDisplayName: review.reviewerDisplayName,
        rating: review.rating,
        reviewedOn: '2026-09-13', // 2026-09-12T20:41Z is 00:41 the next day in Dubai
        zone: ZONE,
      }),
    )

    expect(outcome.kind).toBe('ambiguous')
    if (outcome.kind === 'ambiguous') {
      expect([...outcome.candidateIds].sort()).toEqual([one, two].sort())
    }
    for (const id of [one, two]) {
      expect((await getReview(sql, id))?.googleReviewId).toBeNull()
    }
    expect((await auditCount()) - auditBefore).toBe(0)
  })
})

describe('acceptance — the delivery modes coexist, per row', () => {
  it('records an api delivery in two steps and refuses to also post it by hand', async () => {
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      ingestApiReview(uow, apiPayload('rev-5-ar', '2026-09-11T09:10:00.000Z')),
    )
    await withUnitOfWork(sql, OWNER, (uow) => recordReplySubmittedToApi(uow, id))
    await withUnitOfWork(sql, OWNER, (uow) => recordReplyConfirmedByGoogle(uow, id))

    const stored = await getReview(sql, id)
    expect(stored?.deliveryMode).toBe('api')
    expect(stored?.submittedAtIso).not.toBeNull()
    expect(stored?.confirmedAtIso).not.toBeNull()
    expect(stored?.postedManuallyAtIso).toBeNull()

    // The control, and the reason the mode is a column: a row that says both would be unanswerable
    // afterwards, so the database refuses it rather than storing a contradiction.
    await expect(
      withUnitOfWork(sql, OWNER, (uow) => recordReplyPostedManually(uow, id)),
    ).rejects.toThrow(/google_reviews_delivery_fields_match_mode/)
  })

  it('records a manual delivery on a review the API found', async () => {
    // API access lapsing mid-life is ordinary (docs/10 §4), and the row must say what actually
    // happened rather than what the intake path assumed.
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      ingestApiReview(uow, apiPayload('rev-1-allegation', '2026-09-16T11:10:00.000Z')),
    )
    await withUnitOfWork(sql, OWNER, (uow) => recordReplyPostedManually(uow, id))
    const stored = await getReview(sql, id)
    expect(stored?.deliveryMode).toBe('manual')
    expect(stored?.postedManuallyAtIso).not.toBeNull()
    expect(stored?.submittedAtIso).toBeNull()
  })
})

describe('acceptance — the queue belongs to one connection and one listing', () => {
  it('returns only the rows of the connection and place it was asked for', async () => {
    await withUnitOfWork(sql, OWNER, (uow) =>
      ingestApiReview(uow, apiPayload('rev-5-en', '2026-09-10T18:30:00.000Z')),
    )
    await withUnitOfWork(sql, OWNER, (uow) =>
      recordManualReview(uow, {
        connectionId,
        placeId: PLACE,
        source: 'email_parse',
        rating: 4,
        reviewerDisplayName: fixture('rev-3-mixed').reviewerDisplayName,
        reviewedAtIso: '2026-09-17T10:00:00.000Z',
      }),
    )
    // The second listing, under the second connection: the one-to-many case from docs/10 §2.
    await withUnitOfWork(sql, OWNER, (uow) =>
      recordManualReview(uow, {
        connectionId: otherConnectionId,
        placeId: OTHER_PLACE,
        source: 'paste',
        rating: 1,
        reviewerDisplayName: fixture('rev-1-allegation').reviewerDisplayName,
        reviewedAtIso: '2026-09-17T11:00:00.000Z',
      }),
    )

    const queue = await listReviewQueue(sql, { connectionId, placeId: PLACE })
    expect(queue).toHaveLength(2)
    expect(queue.every((row) => row.connectionId === connectionId && row.placeId === PLACE)).toBe(
      true,
    )
    // Newest first, so the oldest review is not what the owner is shown at the top of the queue.
    expect(queue[0]?.reviewedAtIso).toBe('2026-09-17T10:00:00.000Z')

    // The control: the other connection's queue holds its own row, so the two-row result above is the
    // scoping working rather than three rows never having been written.
    const other = await listReviewQueue(sql, {
      connectionId: otherConnectionId,
      placeId: OTHER_PLACE,
    })
    expect(other).toHaveLength(1)
    expect(await reviewCount()).toBe(3)
  })

  it('refuses a manual review whose source claims the API found it', async () => {
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        recordManualReview(uow, {
          connectionId,
          placeId: PLACE,
          // The compiler already rejects this; the runtime guard is for a caller reached from JSON.
          source: 'api' as 'paste',
          rating: 5,
          reviewerDisplayName: ANONYMOUS,
          reviewedAtIso: '2026-09-17T12:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(/google_review_id/)
  })

  it('refuses a rating outside 1..5 before the database has to', async () => {
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        recordManualReview(uow, {
          connectionId,
          placeId: PLACE,
          source: 'paste',
          rating: 6,
          reviewerDisplayName: ANONYMOUS,
          reviewedAtIso: '2026-09-17T12:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(/rating must be an integer 1-5/)
  })
})
