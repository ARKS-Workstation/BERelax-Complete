import {
  instantFromIso,
  REVIEW_ESCALATION_LEXICON,
  REVIEW_ESCALATION_LEXICON_VERSION,
  type ReviewRoutingPolicy,
  replayReviewRouting,
  reviewEscalationLexiconFor,
  reviewVerdictForRule,
  routeReview,
} from '@berelax/core'
import {
  createConnection,
  getReview,
  ingestApiReview,
  readSetting,
  recordManualReview,
  recordRoutingVerdict,
  type Sql,
  withUnitOfWork,
  writeSetting,
} from '@berelax/db'
import { REVIEW_FIXTURES, type Review } from '@berelax/providers/google'
import { MINIMUM_REVIEW_COOLING_OFF_HOURS, REVIEW_AUTOSEND_SETTING_KEY } from '@berelax/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * G-REV-03 — routing against a real database and the real review fixtures.
 *
 * ## Why this file is in `packages/google`
 *
 * The same argument `review-queue.itest.ts` makes for itself. This exercises a **triple**:
 * `@berelax/core`'s routing table, `@berelax/db`'s verdict write, and the fake Google provider's
 * `REVIEW_FIXTURES`. `packages/google` is the only package that depends on all three —
 * `packages/fixtures` does not depend on `@berelax/providers` — and a test is not a licence to widen a
 * package's dependencies.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. Rows
 * are removed **reviews first**, because `google_reviews.connection_id` is `ON DELETE RESTRICT` and a
 * leftover review would fail the next file's connection cleanup on a constraint that has nothing to do
 * with it. `audit_event` is append-only (ADR 0008), so every assertion about it here is a **delta**
 * counted in SQL — not a total, and not read through a capped reader.
 *
 * `app_setting` is not append-only and IS shared with every other file in the suite, so the one setting
 * this file changes is written through `writeSetting` and restored in `afterAll` through `writeSetting`
 * as well. Restoring it with a direct UPDATE would skip the history trigger and leave
 * `app_setting_history` claiming the value is still enabled.
 *
 * ## No invented names
 *
 * Every reviewer label comes from `REVIEW_FIXTURES`, including on the pasted rows: a pasted review's
 * reviewer name is copied from Google's own notification email. Two of those fixture strings are also
 * quoted in `packages/core/src/reviews/escalation-lexicon.test.ts`, which may not import the provider —
 * this file asserts the copies are byte-identical, so the unit suite cannot drift away from the real data.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const OWNER = { kind: 'staff', id: '55555555-5555-5555-5555-555555555555', label: 'Owner' } as const
const PLACE = 'ChIJ_berelax_routing_place'
const CT = Buffer.from('ciphertext-stand-in')

/** The two strings `packages/core`'s unit suite keeps its own copy of. */
const POSITIVE_ENGLISH = 'Best massage in Abu Dhabi. Very professional and the place is spotless.'
const POSITIVE_ARABIC = 'مكان ممتاز ونظيف، والخدمة رائعة. أنصح به بشدة.'

let sql: Sql
let connectionId = ''

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

/** A delta, counted in SQL. `audit_event` only grows, so a total is a different number every run. */
async function routedAuditCount(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
    where entity_type = 'google_review' and action = 'google_review.routed'
  `
  return Number(row?.n ?? '0')
}

/** How many justifications this key has recorded. Counted in SQL, not read through a capped reader. */
async function justifiedChangeCount(key: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from app_setting_history
    where key = ${key} and justification is not null
  `
  return Number(row?.n ?? '0')
}

beforeAll(() => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await sql`delete from google_reviews`
  await sql`delete from google_connections`
  // Restore the shared setting through the same path that changed it, so `app_setting_history` records
  // the restoration too. A direct UPDATE would skip the 0036 trigger and leave the history claiming the
  // autoresponder is still enabled for every later reader of it.
  await withUnitOfWork(sql, OWNER, (uow) =>
    writeSetting(uow, {
      key: REVIEW_AUTOSEND_SETTING_KEY,
      value: false,
      role: 'owner',
      actorLabel: 'Owner',
      justification: 'G-REV-03 integration test restoring the compliance-locked default',
    }),
  )
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from google_reviews`
  await sql`delete from google_connections`
  connectionId = await seedConnection('sub-review-routing', PLACE)
})

/** A policy with everything an owner could enable, so the floors are what is being tested. */
function permissivePolicy(nowIso: string, autosend: unknown = true): ReviewRoutingPolicy {
  return {
    now: instantFromIso(nowIso),
    autosendEnabledSetting: autosend,
    businessProfileAccessSetting: true,
    coolingOffHoursSetting: MINIMUM_REVIEW_COOLING_OFF_HOURS,
    replyLanguagesSetting: ['en', 'ar'],
    lexicon: REVIEW_ESCALATION_LEXICON,
  }
}

describe('acceptance — the fixtures the unit suite copies are the real ones', () => {
  it('quotes the five-star English and Arabic reviews byte-identically', () => {
    expect(fixture('rev-5-en').comment).toBe(POSITIVE_ENGLISH)
    expect(fixture('rev-5-ar').comment).toBe(POSITIVE_ARABIC)
  })
})

describe('acceptance — every verdict persists its rule and its lexicon version', () => {
  it('records all four routing columns together, with one audit row', async () => {
    const review = fixture('rev-1-allegation')
    const before = await routedAuditCount()
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      recordManualReview(uow, {
        connectionId,
        placeId: PLACE,
        source: 'paste',
        rating: review.rating,
        comment: review.comment ?? null,
        reviewerDisplayName: review.reviewerDisplayName,
        reviewedAtIso: review.createdAtIso,
      }),
    )

    // Unrouted: all four columns NULL, which is the only honest spelling of "the router has not seen it".
    const unrouted = await getReview(sql, id)
    expect(unrouted?.routingVerdict).toBeNull()
    expect(unrouted?.routingRuleId).toBeNull()
    expect(unrouted?.routingLexiconVersion).toBeNull()
    expect(unrouted?.routedAtIso).toBeNull()

    const decision = routeReview({
      review: {
        rating: review.rating,
        commentText: review.comment ?? null,
        reviewedAt: instantFromIso(review.createdAtIso),
      },
      policy: permissivePolicy('2026-09-20T12:00:00.000Z'),
    })
    expect(decision.verdict).toBe('escalate')
    expect(decision.rule).toBe('rating_escalates')

    const outcome = await withUnitOfWork(sql, OWNER, (uow) =>
      recordRoutingVerdict(uow, id, {
        verdict: decision.verdict,
        ruleId: decision.rule,
        lexiconVersion: decision.lexiconVersion,
        matchedTerms: decision.matches.map((match) => match.term),
        categories: [...decision.categories],
      }),
    )
    expect(outcome).toBe('routed')

    const routed = await getReview(sql, id)
    expect(routed?.routingVerdict).toBe('escalate')
    expect(routed?.routingRuleId).toBe('rating_escalates')
    expect(routed?.routingLexiconVersion).toBe(REVIEW_ESCALATION_LEXICON_VERSION)
    expect(routed?.routedAtIso).not.toBeNull()
    // A delta of one, not a total.
    expect(await routedAuditCount()).toBe(before + 1)
  })

  it('does not route a review twice, and writes no second audit row when replayed', async () => {
    const review = fixture('rev-3-mixed')
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      recordManualReview(uow, {
        connectionId,
        placeId: PLACE,
        source: 'email_parse',
        rating: review.rating,
        comment: review.comment ?? null,
        reviewerDisplayName: review.reviewerDisplayName,
        reviewedAtIso: review.createdAtIso,
      }),
    )
    const verdict = {
      verdict: 'escalate' as const,
      ruleId: 'rating_below_auto_send_band',
      lexiconVersion: REVIEW_ESCALATION_LEXICON_VERSION,
    }
    expect(await withUnitOfWork(sql, OWNER, (uow) => recordRoutingVerdict(uow, id, verdict))).toBe(
      'routed',
    )
    const after = await routedAuditCount()
    // An agent run is at-least-once like every other job (docs/10 §7), so the second call is normal traffic.
    expect(await withUnitOfWork(sql, OWNER, (uow) => recordRoutingVerdict(uow, id, verdict))).toBe(
      'already_routed',
    )
    expect(await routedAuditCount()).toBe(after)
    // And the stored decision is unchanged: the first verdict is the record of what the queue did.
    expect((await getReview(sql, id))?.routingRuleId).toBe('rating_below_auto_send_band')
  })

  it('refuses a verdict outside the vocabulary before the database has to', async () => {
    const review = fixture('rev-4-star-only')
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      recordManualReview(uow, {
        connectionId,
        placeId: PLACE,
        source: 'paste',
        rating: review.rating,
        reviewerDisplayName: review.reviewerDisplayName,
        reviewedAtIso: review.createdAtIso,
      }),
    )
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        recordRoutingVerdict(uow, id, {
          verdict: 'send_it',
          ruleId: 'rating_escalates',
          lexiconVersion: REVIEW_ESCALATION_LEXICON_VERSION,
        }),
      ),
    ).rejects.toThrow(/Unknown routing verdict/)
    // A rule id or version that says nothing is refused too: a decision nobody can explain is not one.
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        recordRoutingVerdict(uow, id, {
          verdict: 'escalate',
          ruleId: '  ',
          lexiconVersion: REVIEW_ESCALATION_LEXICON_VERSION,
        }),
      ),
    ).rejects.toThrow(/rule id that decided it/)
    expect((await getReview(sql, id))?.routingVerdict).toBeNull()
  })
})

describe('acceptance — a historical verdict is reproduced from the stored row alone', () => {
  it('re-derives the same verdict and rule from the stored lexicon version', async () => {
    const review = fixture('rev-2-names-staff')
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      recordManualReview(uow, {
        connectionId,
        placeId: PLACE,
        source: 'paste',
        rating: review.rating,
        comment: review.comment ?? null,
        reviewerDisplayName: review.reviewerDisplayName,
        reviewedAtIso: review.createdAtIso,
      }),
    )
    const routable = {
      rating: review.rating,
      commentText: review.comment ?? null,
      reviewedAt: instantFromIso(review.createdAtIso),
    }
    const original = routeReview({
      review: routable,
      policy: permissivePolicy('2026-09-20T12:00:00.000Z'),
    })
    await withUnitOfWork(sql, OWNER, (uow) =>
      recordRoutingVerdict(uow, id, {
        verdict: original.verdict,
        ruleId: original.rule,
        lexiconVersion: original.lexiconVersion,
      }),
    )

    // Everything the replay gets comes off the row. The lexicon is resolved from the stored version.
    const stored = await getReview(sql, id)
    const replay = replayReviewRouting({
      review: {
        rating: stored?.rating ?? 0,
        commentText: stored?.comment ?? null,
        reviewedAt: instantFromIso(stored?.reviewedAtIso ?? '1970-01-01T00:00:00.000Z'),
      },
      policy: {
        now: instantFromIso('2026-09-20T12:00:00.000Z'),
        autosendEnabledSetting: true,
        businessProfileAccessSetting: true,
        coolingOffHoursSetting: MINIMUM_REVIEW_COOLING_OFF_HOURS,
        replyLanguagesSetting: ['en', 'ar'],
      },
      storedLexiconVersion: stored?.routingLexiconVersion,
      lexiconFor: reviewEscalationLexiconFor,
    })
    expect(replay.verdict).toBe(stored?.routingVerdict)
    expect(replay.rule).toBe(stored?.routingRuleId)
    expect(replay.lexiconVersion).toBe(stored?.routingLexiconVersion)
  })

  it('reads a stored rule id this build does not know as escalate, never as auto_send', async () => {
    // The row a later build writes and this one reads. `routing_rule_id` deliberately has no CHECK
    // constraint against the rule list — the list changes with the table and a copy in SQL would drift —
    // so the safety of an unknown id rests entirely on `reviewVerdictForRule` answering `escalate`.
    const review = fixture('rev-1-star-only')
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      recordManualReview(uow, {
        connectionId,
        placeId: PLACE,
        source: 'paste',
        rating: review.rating,
        reviewerDisplayName: review.reviewerDisplayName,
        reviewedAtIso: review.createdAtIso,
      }),
    )
    await withUnitOfWork(sql, OWNER, (uow) =>
      recordRoutingVerdict(uow, id, {
        verdict: 'escalate',
        ruleId: 'a_rule_a_later_build_added',
        lexiconVersion: 'a-lexicon-this-build-has-never-seen',
      }),
    )
    const stored = await getReview(sql, id)
    expect(stored?.routingRuleId).toBe('a_rule_a_later_build_added')
    expect(reviewVerdictForRule(stored?.routingRuleId)).toBe('escalate')
    // And the lexicon cannot be resolved, so a replay refuses rather than using today's terms.
    expect(reviewEscalationLexiconFor(stored?.routingLexiconVersion)).toBeNull()
  })
})

describe('acceptance — the database floor holds whatever the application believes', () => {
  it('refuses an auto_send verdict on a one-star review', async () => {
    // Ingested through the API path, so the row is star-only AND in api delivery mode: the other two
    // floors are satisfied and the rating is the only thing left to refuse it. A manual-mode row would be
    // rejected by `..._needs_api_delivery` first, and the probe would report a pass for the wrong
    // constraint (ADR 0003).
    const review = fixture('rev-1-star-only')
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      ingestApiReview(uow, {
        connectionId,
        placeId: PLACE,
        googleReviewId: review.reviewId,
        updateTimeIso: '2026-09-16T00:00:00.000Z',
        rating: review.rating,
        reviewerDisplayName: review.reviewerDisplayName,
        reviewedAtIso: review.createdAtIso,
      }),
    )
    // Written straight to SQL, bypassing `recordRoutingVerdict` entirely: the point is that the floor does
    // not depend on the application remembering it.
    await expect(
      sql`
        update google_reviews set routing_verdict = 'auto_send', routing_rule_id = 'forced',
          routing_lexicon_version = ${REVIEW_ESCALATION_LEXICON_VERSION}, routed_at = now()
        where id = ${id}
      `,
    ).rejects.toThrow(/google_reviews_autosend_needs_high_rating/)
  })

  it('refuses an auto_send verdict on a review with free text, or in manual delivery', async () => {
    const texted = fixture('rev-5-en')
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      ingestApiReview(uow, {
        connectionId,
        placeId: PLACE,
        googleReviewId: texted.reviewId,
        updateTimeIso: '2026-09-11T00:00:00.000Z',
        rating: texted.rating,
        comment: texted.comment ?? null,
        reviewerDisplayName: texted.reviewerDisplayName,
        reviewedAtIso: texted.createdAtIso,
      }),
    )
    await expect(
      sql`
        update google_reviews set routing_verdict = 'auto_send', routing_rule_id = 'forced',
          routing_lexicon_version = ${REVIEW_ESCALATION_LEXICON_VERSION}, routed_at = now()
        where id = ${id}
      `,
    ).rejects.toThrow(/google_reviews_autosend_needs_no_comment/)

    // A star-only review in manual delivery: the rating and the comment satisfy the first two floors, and
    // the third refuses it because there is no API to have sent it through.
    const quiet = fixture('rev-4-star-only')
    const { id: manualId } = await withUnitOfWork(sql, OWNER, (uow) =>
      recordManualReview(uow, {
        connectionId,
        placeId: PLACE,
        source: 'paste',
        rating: quiet.rating,
        reviewerDisplayName: quiet.reviewerDisplayName,
        reviewedAtIso: quiet.createdAtIso,
      }),
    )
    await expect(
      sql`
        update google_reviews set routing_verdict = 'auto_send', routing_rule_id = 'forced',
          routing_lexicon_version = ${REVIEW_ESCALATION_LEXICON_VERSION}, routed_at = now()
        where id = ${manualId}
      `,
    ).rejects.toThrow(/google_reviews_autosend_needs_api_delivery/)
  })

  it('accepts the one shape it permits, so the three refusals above mean something', async () => {
    // The acceptance control. A CHECK constraint that refused everything would satisfy all three probes.
    const quiet = fixture('rev-4-star-only')
    const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
      ingestApiReview(uow, {
        connectionId,
        placeId: PLACE,
        googleReviewId: quiet.reviewId,
        updateTimeIso: '2026-09-13T00:00:00.000Z',
        rating: quiet.rating,
        reviewerDisplayName: quiet.reviewerDisplayName,
        reviewedAtIso: quiet.createdAtIso,
      }),
    )
    const decision = routeReview({
      review: {
        rating: quiet.rating,
        commentText: null,
        reviewedAt: instantFromIso(quiet.createdAtIso),
      },
      policy: permissivePolicy('2026-09-20T12:00:00.000Z'),
    })
    expect(decision.verdict).toBe('auto_send')
    expect(
      await withUnitOfWork(sql, OWNER, (uow) =>
        recordRoutingVerdict(uow, id, {
          verdict: decision.verdict,
          ruleId: decision.rule,
          lexiconVersion: decision.lexiconVersion,
        }),
      ),
    ).toBe('routed')
    expect((await getReview(sql, id))?.routingVerdict).toBe('auto_send')
  })
})

describe('acceptance — compliance-locked, against real app_setting rows', () => {
  it('reads false from a database where nobody has enabled it', async () => {
    // The registry default reached through the real reader: an unseeded key falls back to its declared
    // default rather than to undefined, which is what makes a fresh database behave like a seeded one.
    expect(await readSetting<boolean>(sql, REVIEW_AUTOSEND_SETTING_KEY)).toBe(false)
  })

  it('refuses to enable it without a written justification', async () => {
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        writeSetting(uow, {
          key: REVIEW_AUTOSEND_SETTING_KEY,
          value: true,
          role: 'owner',
          actorLabel: 'Owner',
        }),
      ),
    ).rejects.toThrow(/compliance-locked/)
    expect(await readSetting<boolean>(sql, REVIEW_AUTOSEND_SETTING_KEY)).toBe(false)
  })

  it('refuses a manager, whatever justification they write', async () => {
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        writeSetting(uow, {
          key: REVIEW_AUTOSEND_SETTING_KEY,
          value: true,
          role: 'manager',
          actorLabel: 'Manager',
          justification: 'the owner asked me to',
        }),
      ),
    ).rejects.toThrow(/may not change/)
  })

  it('refuses a cooling-off delay below the floor even with a justification', async () => {
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        writeSetting(uow, {
          key: 'agents.review_autosend_cooling_off_hours',
          value: 1,
          role: 'owner',
          actorLabel: 'Owner',
          justification: 'we want replies to go out faster',
        }),
      ),
    ).rejects.toThrow(/Review auto-send cooling-off delay/)
  })

  it('enables it with a justification, records the reason, and STILL escalates a one-star review', async () => {
    const justifiedBefore = await justifiedChangeCount(REVIEW_AUTOSEND_SETTING_KEY)
    await withUnitOfWork(sql, OWNER, (uow) =>
      writeSetting(uow, {
        key: REVIEW_AUTOSEND_SETTING_KEY,
        value: true,
        role: 'owner',
        actorLabel: 'Owner',
        justification:
          'G-REV-03 integration test: owner enabling auto-send for quiet 5-star reviews',
      }),
    )
    // 0036: the justification reaches the append-only history through the transaction-local set_config.
    // A delta, because the table only grows.
    expect(await justifiedChangeCount(REVIEW_AUTOSEND_SETTING_KEY)).toBe(justifiedBefore + 1)

    const stored = await readSetting<boolean>(sql, REVIEW_AUTOSEND_SETTING_KEY)
    expect(stored).toBe(true)

    // The whole point of the unit, end to end: the switch is on, in the database, written by the owner
    // with a reason — and a one-star review still escalates.
    const oneStar = fixture('rev-1-allegation')
    const decision = routeReview({
      review: {
        rating: oneStar.rating,
        commentText: oneStar.comment ?? null,
        reviewedAt: instantFromIso(oneStar.createdAtIso),
      },
      policy: permissivePolicy('2026-09-20T12:00:00.000Z', stored),
    })
    expect(decision.verdict).toBe('escalate')
    expect(decision.rule).toBe('rating_escalates')

    // And so does a five-star review that mentions an injury.
    const injured = routeReview({
      review: {
        rating: 5,
        commentText: 'Lovely place but the massage bruised my shoulder.',
        reviewedAt: instantFromIso('2026-09-10T00:00:00.000Z'),
      },
      policy: permissivePolicy('2026-09-20T12:00:00.000Z', stored),
    })
    expect(injured.verdict).toBe('escalate')
    expect(injured.rule).toBe('escalation_term_present')

    // The control: with the switch actually on, the one permitted case does send. Without this, the two
    // assertions above would be satisfied by a setting that had not been read at all.
    const quiet = routeReview({
      review: {
        rating: 5,
        commentText: null,
        reviewedAt: instantFromIso('2026-09-10T00:00:00.000Z'),
      },
      policy: permissivePolicy('2026-09-20T12:00:00.000Z', stored),
    })
    expect(quiet.verdict).toBe('auto_send')
  })
})
