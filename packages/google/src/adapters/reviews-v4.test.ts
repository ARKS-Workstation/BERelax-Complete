import type { QueuedReview } from '@berelax/db'
import type { BusinessProfileProvider, Review } from '@berelax/providers/google'
import { describe, expect, it } from 'vitest'
import { simulatedRateLimitClock } from '../rate-limit/token-bucket.ts'
import {
  createReviewsV4Submitter,
  listReviewsV4,
  MYBUSINESS_V4_BASE,
  MYBUSINESS_V4_HOST,
  REVIEW_HAS_NO_GOOGLE_ID,
  reviewsV4Limit,
  reviewsV4ListUrl,
  reviewsV4ReplyUrl,
} from './reviews-v4.ts'

/**
 * The quarantined `v4` adapter: the path, the refusals, and the 6/min cap.
 *
 * Every refusal is asserted with a transport spy at ZERO calls. "The check is before the network call" is
 * the kind of claim a refactor reverses silently, and on this API a spent call is a slot out of a ten-a-
 * minute budget the whole profile shares.
 */

/** A capability row as the picker writes one: the account, the location and the place id. */
const REF = {
  account: 'accounts/fake-location-group-1',
  location: 'locations/fake-al-zahiyah-1',
  placeId: 'ChIJ-fake-place-al-zahiyah',
}

/** The row a v1-only client would have written: the location, and nothing to build a v4 path from. */
const V1_SHAPED_REF = { location: 'locations/fake-al-zahiyah-1', placeId: 'ChIJ-fake-place' }

interface Spy {
  readonly profile: Pick<BusinessProfileProvider, 'listReviews' | 'updateReply'>
  readonly replies: {
    readonly locationId: string
    readonly reviewId: string
    readonly comment: string
  }[]
  readonly lists: string[]
}

function spy(reviews: readonly Review[] = []): Spy {
  const replies: { locationId: string; reviewId: string; comment: string }[] = []
  const lists: string[] = []
  return {
    replies,
    lists,
    profile: {
      async listReviews(locationId) {
        lists.push(locationId)
        return reviews
      },
      async updateReply(args) {
        replies.push(args)
      },
    },
  }
}

const queued = (overrides: Partial<QueuedReview> = {}): QueuedReview =>
  ({
    id: '00000000-0000-7000-8000-000000000001',
    googleReviewId: 'accounts/1/locations/2/reviews/abc',
    ...overrides,
  }) as unknown as QueuedReview

describe('the legacy v4 Reviews adapter', () => {
  it('names the legacy host once, and it is not a v1 host', () => {
    expect(MYBUSINESS_V4_HOST).toBe('mybusiness.googleapis.com')
    expect(MYBUSINESS_V4_BASE).toBe('https://mybusiness.googleapis.com/v4/')
    // The distinction that matters: v1's hosts are different APIs with a different approval state, and a
    // quarantine that confused them would condemn every module that reads a location.
    expect(MYBUSINESS_V4_HOST).not.toContain('businessinformation')
    expect(MYBUSINESS_V4_HOST).not.toContain('accountmanagement')
  })

  it('builds the path from the PERSISTED accountId, which is why it is persisted', () => {
    expect(reviewsV4ListUrl(REF)).toBe(
      'https://mybusiness.googleapis.com/v4/accounts/fake-location-group-1/locations/fake-al-zahiyah-1/reviews',
    )
    expect(reviewsV4ReplyUrl(REF, 'abc')).toBe(
      'https://mybusiness.googleapis.com/v4/accounts/fake-location-group-1/locations/fake-al-zahiyah-1/reviews/abc/reply',
    )
  })

  it('fails loudly on a v1-shaped ref with no accountId, with zero transport calls', async () => {
    const transport = spy()
    const limit = reviewsV4Limit(simulatedRateLimitClock())

    // The URL builders refuse, naming the missing part — not a 404 at 03:00 on a cron job.
    expect(() => reviewsV4ListUrl(V1_SHAPED_REF)).toThrow('account')
    expect(() => reviewsV4ReplyUrl(V1_SHAPED_REF, 'abc')).toThrow('account')
    // And so does the list call, before the transport.
    await expect(
      listReviewsV4({ profile: transport.profile, limit, resourceRef: V1_SHAPED_REF }),
    ).rejects.toThrow('unusable')
    // The submitter refuses at CONSTRUCTION, so a misconfigured row is loud when it is wired.
    expect(() =>
      createReviewsV4Submitter({ profile: transport.profile, limit, resourceRef: V1_SHAPED_REF }),
    ).toThrow('unusable')
    expect(() =>
      createReviewsV4Submitter({ profile: transport.profile, limit, resourceRef: null }),
    ).toThrow('unusable')

    expect(transport.replies).toHaveLength(0)
    expect(transport.lists).toHaveLength(0)
    expect(limit.admitted).toHaveLength(0)
  })

  it('refuses a review with no google_review_id rather than replying to nothing', async () => {
    const transport = spy()
    const limit = reviewsV4Limit(simulatedRateLimitClock())
    const submitter = createReviewsV4Submitter({
      profile: transport.profile,
      limit,
      resourceRef: REF,
    })
    await expect(
      submitter.submit({ review: queued({ googleReviewId: null }), reply: 'Thank you.' }),
    ).rejects.toThrow('nothing on the Google listing to reply')
    // Before the limiter, so a row that can never be delivered does not spend a slot.
    expect(transport.replies).toHaveLength(0)
    expect(limit.admitted).toHaveLength(0)

    // And the refusal is named, so a caller branches on it rather than on the sentence.
    try {
      await submitter.submit({ review: queued({ googleReviewId: null }), reply: 'Thank you.' })
    } catch (error) {
      expect((error as { details?: { reason?: string } }).details?.reason).toBe(
        REVIEW_HAS_NO_GOOGLE_ID,
      )
    }
  })

  it('submits the approved bytes unchanged, appending no signature', async () => {
    const transport = spy()
    const limit = reviewsV4Limit(simulatedRateLimitClock())
    const submitter = createReviewsV4Submitter({
      profile: transport.profile,
      limit,
      resourceRef: REF,
    })
    const approved = 'Thank you for the feedback. We look forward to welcoming you back.'
    await submitter.submit({ review: queued(), reply: approved })

    expect(transport.replies).toHaveLength(1)
    // Byte for byte. `Y9-reply-signature` is open, so a sign-off invented here would be published under
    // the owner's name and indistinguishable from a configured one (the brief's rule 15).
    expect(transport.replies[0]?.comment).toBe(approved)
    expect(transport.replies[0]?.locationId).toContain('/reply')
    expect(transport.replies[0]?.reviewId).toBe('accounts/1/locations/2/reviews/abc')
  })

  it('holds twenty replies to six transport calls in the first minute, delivering all twenty', async () => {
    const transport = spy()
    const clock = simulatedRateLimitClock()
    const limit = reviewsV4Limit(clock)
    const submitter = createReviewsV4Submitter({
      profile: transport.profile,
      limit,
      resourceRef: REF,
    })

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        submitter.submit({
          review: queued({ googleReviewId: `accounts/1/locations/2/reviews/r${index}` }),
          reply: 'Thank you for the feedback.',
        }),
      ),
    )

    // None dropped — a final delivery count, not a queue length.
    expect(transport.replies).toHaveLength(20)
    // At most six in the first simulated minute, which is docs/10 §7's figure.
    expect(limit.admittedWithin(0, 59_999)).toBe(6)
    // And every review was delivered exactly once, in submission order.
    expect(transport.replies.map((call) => call.reviewId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `accounts/1/locations/2/reviews/r${index}`),
    )
  })

  it('lists reviews from the stored reference alone', async () => {
    const transport = spy([
      {
        reviewId: 'accounts/1/locations/2/reviews/one',
        rating: 5,
        reviewerDisplayName: 'A Google user',
        createdAtIso: '2026-09-20T09:00:00.000Z',
      },
    ])
    const found = await listReviewsV4({
      profile: transport.profile,
      limit: reviewsV4Limit(simulatedRateLimitClock()),
      resourceRef: REF,
    })
    expect(found).toHaveLength(1)
    expect(transport.lists).toEqual([reviewsV4ListUrl(REF)])
  })
})
